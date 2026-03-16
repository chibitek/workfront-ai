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
  console.error("Usage: npx tsx scripts/importSlackThreads.ts /path/to/export.zip");
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

function groupMessagesByThread(messages: SlackMessage[]) {
  const threads = new Map<string, SlackMessage[]>();

  for (const msg of messages) {
    const text = cleanText(msg.text || "");
    if (!text || text.length < 20) continue;

    const key = msg.thread_ts || msg.ts;
    if (!key) continue;

    if (!threads.has(key)) {
      threads.set(key, []);
    }

    threads.get(key)!.push({ ...msg, text });
  }

  return threads;
}

function buildThreadRow(channel: string, dateFile: string, threadKey: string, messages: SlackMessage[]) {
  const sorted = messages.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));

  const content = sorted
    .map((m, i) => {
      return `Message ${i + 1}:
${m.text ?? ""}`;
    })
    .join("\n\n");

  if (!content || content.length < 40) return null;

  return {
    source_type: "slack",
    source_url: `slack-export://${channel}/${dateFile}#${threadKey}`,
    title: `${channel} thread - ${dateFile}`,
    content,
    metadata: {
      channel,
      date_file: dateFile,
      thread_ts: threadKey,
      message_count: sorted.length,
    },
  };
}

async function insertBatch(rows: any[]) {
  if (rows.length === 0) return;

  const { error } = await supabase.from("knowledge_base_threads").insert(rows);

  if (error) {
    console.error("Batch insert error:", error.message);
  }
}

async function main() {
  console.log("Starting Slack thread import...");
  console.log("ZIP_PATH:", ZIP_PATH);

  const zip = new AdmZip(path.resolve(ZIP_PATH));
  const entries = zip.getEntries();

  console.log(`Found ${entries.length} entries inside zip`);

  let processedFiles = 0;
  let inserted = 0;
  const batch: any[] = [];
  const BATCH_SIZE = 100;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.endsWith(".json")) continue;

    const parts = entry.entryName.split("/");
    if (parts.length !== 2) continue;

    const channel = parts[0];
    const dateFile = parts[1];
    processedFiles++;

    if (processedFiles % 50 === 0) {
      console.log(`Processed ${processedFiles} JSON files...`);
    }

    try {
      const raw = entry.getData().toString("utf8");
      const messages: SlackMessage[] = JSON.parse(raw);

      const grouped = groupMessagesByThread(messages);

      for (const [threadKey, threadMessages] of grouped.entries()) {
        const row = buildThreadRow(channel, dateFile, threadKey, threadMessages);
        if (!row) continue;

        batch.push(row);

        if (batch.length >= BATCH_SIZE) {
          await insertBatch(batch);
          inserted += batch.length;
          batch.length = 0;

          if (inserted % 1000 === 0) {
            console.log(`Inserted ${inserted} thread rows...`);
          }
        }
      }
    } catch (err) {
      console.error("Failed parsing:", entry.entryName, err);
    }
  }

  if (batch.length > 0) {
    await insertBatch(batch);
    inserted += batch.length;
  }

  console.log(`Done. Inserted ${inserted} thread rows.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
