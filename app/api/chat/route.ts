import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabaseServer";
import { GoogleGenerativeAI } from "@google/generative-ai";

function simplifySearchQuery(input: string) {
  return input
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(
      /\b(for|the|do|we|when|what|is|are|to|can|just|be|or|being|sent|a|an|of|in|on|with)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

export async function POST(req: Request) {
  try {
    console.log("POST /api/chat start");

    const body = await req.json();
    const message = String(body?.message ?? "");
    const sessionId = body?.sessionId as string | undefined;

    if (!message.trim()) {
      return NextResponse.json({ error: "Missing message" }, { status: 400 });
    }

    let sid = sessionId;

    if (!sid) {
      console.log("Creating session...");
      const { data: session, error: sessionError } = await supabaseServer
        .from("chat_sessions")
        .insert({ title: message.slice(0, 60) })
        .select("id")
        .single();

      if (sessionError) {
        return NextResponse.json(
          { error: sessionError.message || "Failed to create session" },
          { status: 500 }
        );
      }

      if (!session) {
        return NextResponse.json(
          { error: "Failed to create session" },
          { status: 500 }
        );
      }

      sid = session.id;
    }

    console.log("Saving user message...");
    const { error: insUserErr } = await supabaseServer
      .from("chat_messages")
      .insert({ session_id: sid, role: "user", content: message });

    if (insUserErr) {
      return NextResponse.json(
        { error: insUserErr.message },
        { status: 500 }
      );
    }

    console.log("Running FTS search...");
    const searchQuery = simplifySearchQuery(message);

    const { data: matches, error: matchErr } = await supabaseServer.rpc(
      "match_knowledge_base_threads_hybrid",
      { query_text: searchQuery, match_count: 10 }
    );

    if (matchErr) {
      return NextResponse.json(
        { error: matchErr.message },
        { status: 500 }
      );
    }

    console.log("SEARCH QUERY:", searchQuery);
    console.log("RAW MATCH COUNT:", matches?.length ?? 0);

    const strongMatches = (matches ?? []).filter(
      (m: any) => (m.score ?? 0) > 0.08
    );

    console.log("STRONG MATCH COUNT:", strongMatches.length);
    console.log(
      "TOP STRONG MATCHES:",
      strongMatches.slice(0, 3).map((m: any) => ({
        title: m.title,
        score: m.score,
        preview: String(m.content ?? "").slice(0, 200),
      }))
    );
    const sources = strongMatches.map((m: any) => ({
      title: m.title ?? "(no title)",
      url: m.source_url ?? "",
      type: m.source_type ?? "",
      score: m.score ?? 0,
    }));

    const context = strongMatches
      .map((m: any, i: number) => {
        return `SOURCE ${i + 1}
    TYPE: ${m.source_type ?? "unknown"}
    TITLE: ${m.title ?? "(no title)"}
    URL: ${m.source_url ?? "(none)"}
    SCORE: ${m.score ?? 0}
    CONTENT:
    ${m.content ?? ""}`;
      })
      .join("\n\n---\n\n");

    console.log("Checking Gemini key...");
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing GEMINI_API_KEY" },
        { status: 500 }
      );
    }

    console.log("Calling Gemini...");
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `You are an internal MSP support assistant for Adobe Workfront.

Rules:
- Use the provided internal context first.
- If the internal context is incomplete but relevant, synthesize the best possible answer from the strongest evidence available.
- Do not ask follow-up questions unless there is truly no useful evidence at all.
- If the internal notes are weak, incomplete, or ambiguous, say so briefly and still provide the best likely answer.
- If external web results are provided, use them as supplemental context and clearly separate internal findings from external findings.
- End with: "Sources:" and list the internal and external sources actually used.

CONTEXT:
${context || "No context found."}

USER QUESTION:
${message}
`;

    const result = await model.generateContent(prompt);
    const answerText = result.response.text();

    console.log("Saving assistant message...");
    const { error: insAsstErr } = await supabaseServer
      .from("chat_messages")
      .insert({ session_id: sid, role: "assistant", content: answerText });

    if (insAsstErr) {
      return NextResponse.json(
        { error: insAsstErr.message },
        { status: 500 }
      );
    }

    console.log("POST /api/chat success");
    return NextResponse.json({
      sessionId: sid,
      answer: answerText,
      sources,
      debug: {
        searchQuery,
        rawMatchCount: matches?.length ?? 0,
        strongMatchCount: strongMatches.length,
      },
    });
  } catch (err: any) {
    console.error("POST /api/chat fatal error:", err);
    return NextResponse.json(
      { error: err?.message || "Unknown server error" },
      { status: 500 }
    );
  }
}
