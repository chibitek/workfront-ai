import "dotenv/config";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Fixed namespace so each slug always maps to the same row id (UUID v5).
// This lets us upsert on the primary key, which already has a unique index,
// so re-running the script updates rows in place instead of duplicating them
// (the table has no unique constraint on source_url, and it's too large to
// scan-and-delete within Supabase's statement timeout).
const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function uuidV5(name: string): string {
  const nsBytes = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([nsBytes, Buffer.from(name, "utf8")]))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Curated, team-verified Workfront Q&A. These are inserted into the same
// knowledge_base_threads table the chat route searches first
// (match_knowledge_base_threads_hybrid), so the assistant can answer them
// directly. The question text is included in both the title and the content
// so full-text search matches on the user's phrasing.
type CuratedEntry = {
  slug: string;
  question: string;
  answer: string;
};

const ENTRIES: CuratedEntry[] = [
  {
    slug: "add-timesheets-to-user",
    question: "How do I add the ability of timesheets to a user?",
    answer: `Adding timesheet ability to a user takes two steps: confirming their access level allows timesheets, then assigning them a timesheet profile.

Step 1: Verify or update the user's access level
The user must have an access level that allows them to view or edit timesheets.
1. Click the Main Menu icon (the grid icon in the top right) and select Users.
2. Click the name of the user you want to edit, then click Edit (or click the three dots next to their name and select Edit).
3. In the Access Level dropdown, make sure they are assigned a level (like Worker or Plan) that includes timesheet access.
Admin note: To check what a specific access level allows, go to Setup > Access Levels, click the level, and make sure Timesheets & Hours is set to View or Edit.

Step 2: Assign a timesheet profile to the user
A timesheet profile is required for the system to generate actual timesheets for the user.
1. While still editing the user's profile (from the Users area), look at the left-hand navigation menu of the edit pop-up and click Timesheets.
2. Configure the following fields:
   - Timesheet Profile: Select the appropriate profile from the dropdown (e.g., Standard Weekly, Bi-weekly). This dictates the layout and frequency of their timesheets.
   - Timesheet Approver (optional): Select the manager or user responsible for reviewing and approving this user's timesheets.
   - Overtime Approver (optional): Select who approves any overtime hours, if applicable.
3. Click Save Changes in the bottom right.`,
  },
  {
    slug: "pto-requester-timesheet-access",
    question: "Does the access level PTO Requester include timesheet access?",
    answer: `No. A "PTO Requester" access level (a custom version built on the default Requestor or Contributor license) does not include timesheet access.

To give a PTO Requester the ability to fill out timesheets, upgrade their access level to a Worker (legacy model) or a Standard (new model) level:
1. Go to Main Menu > Users and edit the user.
2. Change their Access Level to a standard Worker level, or a custom access level built on the Worker/Standard license.`,
  },
  {
    slug: "assign-timesheet-approver-manager",
    question: "How do I add a user so they appear under a manager (assign a timesheet approver)?",
    answer: `To make a user's timesheets route to a manager, assign that manager as the user's Timesheet Approver.

1. Click the Main Menu icon (the grid icon) in the top right and select Users.
2. Locate the user who needs their timesheets approved, check the box next to their name, and click Edit (or open their profile and click Edit).
3. In the edit pop-up window, look at the left-hand navigation menu and click Timesheets.
4. In the Timesheet Approver field, type and select the name of the manager.
5. Optional: If someone else handles overtime, fill out the Overtime Approver field too.
6. Click Save Changes.`,
  },
];

function buildRow(entry: CuratedEntry) {
  return {
    id: uuidV5(`curated_qa:${entry.slug}`),
    source_type: "curated_qa",
    source_url: `curated://workfront/timesheets/${entry.slug}`,
    title: entry.question,
    content: `Question: ${entry.question}\n\nAnswer:\n${entry.answer}`,
    metadata: {
      topic: "timesheets",
      slug: entry.slug,
      curated: true,
    },
  };
}

async function main() {
  console.log(`Upserting ${ENTRIES.length} curated knowledge entries...`);

  const rows = ENTRIES.map(buildRow);
  const keepIds = new Set(rows.map((r) => r.id));

  // Clean up any stale curated rows from earlier runs (e.g. rows created with
  // random ids before this script used deterministic UUIDs). Deleting by id
  // hits the primary-key index, so it's fast even on a large table.
  const { data: existing, error: selError } = await supabase
    .from("knowledge_base_threads")
    .select("id")
    .eq("source_type", "curated_qa");

  if (selError) {
    console.error("Lookup error:", selError.message);
    process.exit(1);
  }

  const staleIds = (existing ?? [])
    .map((r) => r.id)
    .filter((id) => !keepIds.has(id));

  if (staleIds.length > 0) {
    const { error: delError } = await supabase
      .from("knowledge_base_threads")
      .delete()
      .in("id", staleIds);

    if (delError) {
      console.error("Cleanup error:", delError.message);
      process.exit(1);
    }
    console.log(`Removed ${staleIds.length} stale curated row(s).`);
  }

  // Upsert on the primary key (which has a unique index), so re-running the
  // script overwrites the matching rows instead of inserting duplicates.
  const { error } = await supabase
    .from("knowledge_base_threads")
    .upsert(rows, { onConflict: "id" });

  if (error) {
    console.error("Upsert error:", error.message);
    process.exit(1);
  }

  for (const row of rows) {
    console.log("Upserted:", row.metadata.slug, "->", row.id);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
