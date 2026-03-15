import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabaseServer";
import { GoogleGenerativeAI } from "@google/generative-ai";

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
    const { data: matches, error: matchErr } = await supabaseServer.rpc(
      "match_knowledge_base_fts",
      { query_text: message, match_count: 6 }
    );

    if (matchErr) {
      return NextResponse.json(
        { error: matchErr.message },
        { status: 500 }
      );
    }

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
    });
  } catch (err: any) {
    console.error("POST /api/chat fatal error:", err);
    return NextResponse.json(
      { error: err?.message || "Unknown server error" },
      { status: 500 }
    );
  }
}
