import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabaseServer";
import { createServerSupabaseClient } from "@/lib/supabaseServerAuth";
import { GoogleGenerativeAI } from "@google/generative-ai";

function simplifySearchQuery(input: string) {
  return input
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(for|the|do|we|when|what|is|are|to|can|just|be|or|being|sent|a|an|of|in|on|with|how)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function POST(req: Request) {
  try {
    console.log("POST /api/chat start");

    // Validate auth
    const supabaseAuth = await createServerSupabaseClient();
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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

    console.log("Running internal search...");
    const searchQuery = simplifySearchQuery(message);

    const { data: internalMatches, error: internalErr } = await supabaseServer.rpc(
      "match_knowledge_base_threads_hybrid",
      { query_text: searchQuery, match_count: 10 }
    );

    if (internalErr) {
      return NextResponse.json(
        { error: internalErr.message },
        { status: 500 }
      );
    }

    const strongInternalMatches = (internalMatches ?? []).filter(
      (m: any) => (m.score ?? m.rank ?? 0) > 0.05
    );

    console.log("Internal search query:", searchQuery);
    console.log("Internal matches:", strongInternalMatches.length);

    let finalMatches = strongInternalMatches;
    let sourceMode: "internal" | "external" = "internal";

    if (finalMatches.length === 0) {
      console.log("No strong internal matches. Running external fallback...");

      const { data: externalMatches, error: externalErr } = await supabaseServer.rpc(
        "match_knowledge_base_external_fts",
        { query_text: searchQuery, match_count: 6 }
      );

      if (externalErr) {
        return NextResponse.json(
          { error: externalErr.message },
          { status: 500 }
        );
      }

      finalMatches = (externalMatches ?? []).filter(
        (m: any) => (m.rank ?? 0) > 0.01
      );

      sourceMode = "external";
    }

    const sources = finalMatches.map((m: any) => ({
      title: m.title ?? "(no title)",
      url: m.source_url ?? "",
      type: m.source_type ?? "",
      score: m.score ?? m.rank ?? 0,
    }));

    const context = finalMatches
      .map((m: any, i: number) => {
        return `SOURCE ${i + 1}
    TYPE: ${m.source_type ?? "unknown"}
    TITLE: ${m.title ?? "(no title)"}
    URL: ${m.source_url ?? "(none)"}
    SCORE: ${m.score ?? m.rank ?? 0}
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
- Answer ONLY from the internal context below.
- Do not use general Workfront knowledge if internal context exists.
- If the internal context is partial but relevant, summarize the best answer from it. Then supplement with general Workfront knowledge.
- If the internal context clearly answers the question, answer directly and confidently.
- NEVER include raw source URLs, file paths, or slack-export references in your answer. The user should not see any "slack-export://", "json#", or similar internal identifiers.
- Keep your answer clean, concise, and easy to read.
- Use numbered steps or bullet points when explaining a process.
- Do NOT end with a "Sources:" section.

INTERNAL CONTEXT:
${context}

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
        rawMatchCount: internalMatches?.length ?? 0,
        strongMatchCount: strongInternalMatches.length,
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
