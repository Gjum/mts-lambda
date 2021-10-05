import { Handler } from "@netlify/functions";
import fetch from "node-fetch";

const backlogDays = 31; // expired registrations older than this won't display
const tsvSkipRows = 2; // per-player entries start after this many rows; e.g. one row for information header, one row for column names

// the following must be provided via environment variables
const {
	// spreadsheet format:
	// one line ignored (e.g. information header)
	// one line that has the last updated date in column I; remaining columns are ignored and could be e.g. column names
	// remaining lines of the format: mcName, tag, validDateStr, expireDateStr, remaining columns are ignored
	VOTER_REGISTRATION_TSV_URL,
	// messages will be updated through this webhook
	VOTER_REGISTRATION_WEBHOOK_URL,
	// space separated message ids that will be updated with the registrations list
	// if the full list is longer than 2000 characters (Discord limit) it will be split across these messages.
	// the messages must have been *created in advance* through the webhook, for example like this:
	// curl -X POST --header 'Content-Type: application/json' --data '{"content":"(placeholder)","username":"Voter Registry","avatar_url":"https://example.com/something.png"}' https://discord.com/api/webhooks/123123123123123123/abc123_abc123_abc123_abc123_abc123
	VOTER_REGISTRATION_MSG_IDS,
	// the "secret" url query parameter must contain this value to prevent unauthorized requests
	VOTER_REGISTRATION_SECRET,
} = process.env;

const daySec = 24 * 60 * 60;

/** expects DD/MM/YYYY format */
function parseDateStr(str: string): number {
	const [dd, mm, yyyy] = str.trim().split("/");
	const dateMs = Date.UTC(+yyyy, +mm - 1, +dd);
	return Math.floor(dateMs / 1000);
}

/** escape Discord formatting characters */
const escapeRaw = (s: string) => s.replaceAll(/[_~*`\\]/g, (c) => "\\" + c);

export const handler: Handler = async (event) => {
	if (event.queryStringParameters?.secret !== VOTER_REGISTRATION_SECRET) {
		return { statusCode: 400, body: `Invalid secret` };
	}

	for (const envName of [
		"VOTER_REGISTRATION_TSV_URL",
		"VOTER_REGISTRATION_WEBHOOK_URL",
		"VOTER_REGISTRATION_MSG_IDS",
	]) {
		if (!process.env[envName]) {
			return {
				statusCode: 500,
				body: `Missing environment variable ${envName}`,
			};
		}
	}

	const tsv = await fetch(VOTER_REGISTRATION_TSV_URL!).then((r) => r.text());

	const sheetLastUpdatedDateStr = tsv.split("\n")[1].split("\t")[8];
	const sheetLastUpdatedSec = parseDateStr(sheetLastUpdatedDateStr);

	let fullMsgs = [];
	let fullMsg = `Up-To-Date Voter Registration (as of <t:${sheetLastUpdatedSec}:D>)\n\nThese individuals are registered to vote in all elections, through the date listed. If your name is not currently listed, or ~~crossed out~~, you are not registered to vote.\n`;

	let numPlayers = 0;
	for (const tsvLine of tsv.split("\n").slice(tsvSkipRows)) {
		if (!tsvLine.trim()) continue;
		let [mcName, tag, validDateStr, expireDateStr] = tsvLine.split("\t");
		mcName = mcName.trim();
		tag = tag.trim();
		const validSec = parseDateStr(validDateStr);
		const expireSec = parseDateStr(expireDateStr);

		++numPlayers;

		if (expireSec < sheetLastUpdatedSec - backlogDays * daySec) continue;

		const name = escapeRaw(mcName);

		let line;
		if (validSec > sheetLastUpdatedSec) {
			line = `*~~${name}~~ (begins <t:${validSec}:D>) (valid through <t:${expireSec}:D>)*`;
		} else if (expireSec > sheetLastUpdatedSec) {
			line = `**${name}** (valid through <t:${expireSec}:D>)`;
		} else {
			line = `~~${name}~~ (ended <t:${expireSec}:D>)`;
		}

		if ((fullMsg + line).length < 2000) {
			fullMsg += "\n" + line;
		} else {
			fullMsgs.push(fullMsg);
			fullMsg = line.trim();
		}
	}
	fullMsgs.push(fullMsg);

	let whRes = "";
	for (const msgId of VOTER_REGISTRATION_MSG_IDS!.split(" ")) {
		const content = fullMsgs.shift() ?? "-";
		whRes += await fetch(
			`${VOTER_REGISTRATION_WEBHOOK_URL!}/messages/${msgId}`,
			{
				method: "patch",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content }),
			}
		).then((r) => r.text());
		whRes += "\n";
	}

	return {
		statusCode: 200,
		body: [
			`Last updated: ${new Date(1000 * sheetLastUpdatedSec).toISOString()}`,
			`Players: ${numPlayers}`,
		].join("\n"),
	};
};
