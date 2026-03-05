import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabaseServer";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function POST(req: Request) {
  const body = await req.json();
  const message = String(body?.message ?? "");
  const sessionId = body?.sessionId as string | undefined;

  if (!message.trim()) {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  // 1) Create or reuse a session
  let sid = sessionId;
  if (!sid) {
    const { data: session, error } = await supabaseServer
      .from("chat_sessions")
      .insert({ title: message.slice(0, 60) })
      .select("id")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    sid = session.id;
  }

  // 2) Save user message
  const { error: insUserErr } = await supabaseServer
    .from("chat_messages")
    .insert({ session_id: sid, role: "user", content: message });

  if (insUserErr) return NextResponse.json({ error: insUserErr.message }, { status: 500 });

  // 3) Retrieve relevant context from Supabase (FTS)
  const { data: matches, error: matchErr } = await supabaseServer.rpc(
    "match_knowledge_base_fts",
    { query_text: message, match_count: 6 }
  );

  if (matchErr) return NextResponse.json({ error: matchErr.message }, { status: 500 });

  const sources = (matches ?? []).map((m: any) => ({
    title: m.title ?? "(no title)",
    url: m.source_url ?? "",
    type: m.source_type ?? "",
    rank: m.rank ?? 0,
  }));

  const context = (matches ?? [])
    .map((m: any, i: number) => {
      return `SOURCE ${i + 1}
TYPE: ${m.source_type ?? "unknown"}
TITLE: ${m.title ?? "(no title)"}
URL: ${m.source_url ?? "(none)"}
CONTENT:
${m.content ?? ""}`;
    })
    .join("\n\n---\n\n");

  // 4) Ask Gemini to answer using ONLY the retrieved context
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing GEMINI_API_KEY" }, { status: 500 });
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `You are an internal MSP support assistant for Adobe Workfront.

Rules:
- Use ONLY the context provided below.
- If the answer is not in the context, say: "I don't see that in our internal notes yet." Then ask 1-2 follow-up questions.
- Provide a short, practical answer with steps.
- End with: "Sources:" and list the URLs you used (only URLs that appear in the context).

CONTEXT:
${context || "No context found."}

QUESTION:
${message}
`;

  const result = await model.generateContent(prompt);
  const answerText = result.response.text();

  // 5) Save assistant message
  const { error: insAsstErr } = await supabaseServer
    .from("chat_messages")
    .insert({ session_id: sid, role: "assistant", content: answerText });

  if (insAsstErr) return NextResponse.json({ error: insAsstErr.message }, { status: 500 });

  // 6) Return response
  return NextResponse.json({
    sessionId: sid,
    answer: answerText,
    sources,
  });
}
