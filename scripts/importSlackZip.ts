import "dotenv/config";
import AdmZip from "adm-zip";
import { createClient } from "@supabase/supabase-js";
import path from "path";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ZIP_PATH = process.argv[2];

if (!ZIP_PATH) {
  console.error("Usage: npx tsx scripts/importSlackZip.ts /path/to/export.zip");
  process.exit(1);
}

type SlackMessage = {
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
};

function cleanText(text: string) {
  return text
    .replace(/<@[A-Z0-9]+>/g, "@user")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRow(channel: string, dateFile: string, message: SlackMessage) {
  const raw = message.text || "";
  const content = cleanText(raw);

  if (!content || content.length < 20) return null;

  return {
    source_type: "slack",
    source_url: `slack-export://${channel}/${dateFile}#${message.ts ?? ""}`,
    title: `${channel} - ${dateFile}`,
    content,
    metadata: {
      channel,
      date_file: dateFile,
      ts: message.ts ?? null,
      thread_ts: message.thread_ts ?? null,
      reply_count: message.reply_count ?? 0,
    },
  };
}

async function main() {
  const zip = new AdmZip(path.resolve(ZIP_PATH));
  const entries = zip.getEntries();

  let inserted = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.endsWith(".json")) continue;

    const parts = entry.entryName.split("/");
    if (parts.length !== 2) continue;

    const channel = parts[0];
    const dateFile = parts[1];

    try {
      const raw = entry.getData().toString("utf8");
      const messages: SlackMessage[] = JSON.parse(raw);

      for (const msg of messages) {
        const row = buildRow(channel, dateFile, msg);

        if (!row) {
          skipped++;
          continue;
        }

        const { error } = await supabase.from("knowledge_base").insert(row);

        if (error) {
          console.error("Insert error:", error.message, row.title);
        } else {
          inserted++;
        }
      }
    } catch (err) {
      console.error("Failed parsing:", entry.entryName, err);
    }
  }

  console.log(`Done. Inserted ${inserted} rows. Skipped ${skipped}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
