import { supabaseServer } from "@/lib/supabaseServer";
import { createServerSupabaseClient } from "@/lib/supabaseServerAuth";
import { Ollama } from "ollama";

function simplifySearchQuery(input: string) {
  return input
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(for|the|do|we|when|what|is|are|to|can|just|be|or|being|sent|a|an|of|in|on|with|how)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Initialize Ollama client — points to Ollama Cloud in production,
// can be overridden to localhost for local development.
const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || "https://ollama.com",
  ...(process.env.OLLAMA_API_KEY
    ? { headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } }
    : {}),
});

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:31b";

export async function POST(req: Request) {
  try {
    console.log("POST /api/chat start");

    // Validate auth
    const supabaseAuth = await createServerSupabaseClient();
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();

    if (authError || !user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const message = String(body?.message ?? "");
    const sessionId = body?.sessionId as string | undefined;
    const imageBase64 = body?.image as string | undefined;

    if (!message.trim()) {
      return Response.json({ error: "Missing message" }, { status: 400 });
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
        return Response.json(
          { error: sessionError.message || "Failed to create session" },
          { status: 500 }
        );
      }

      if (!session) {
        return Response.json(
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
      return Response.json(
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
      return Response.json(
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

    if (finalMatches.length === 0) {
      console.log("No strong internal matches. Running external fallback...");

      const { data: externalMatches, error: externalErr } = await supabaseServer.rpc(
        "match_knowledge_base_external_fts",
        { query_text: searchQuery, match_count: 6 }
      );

      if (externalErr) {
        return Response.json(
          { error: externalErr.message },
          { status: 500 }
        );
      }

      finalMatches = (externalMatches ?? []).filter(
        (m: any) => (m.rank ?? 0) > 0.01
      );
    }

    console.log("Calling Ollama (Gemma 4) with streaming...");

    if (!process.env.OLLAMA_API_KEY) {
      return Response.json(
        { error: "Missing OLLAMA_API_KEY" },
        { status: 500 }
      );
    }

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

    const systemPrompt = `You are an expert Adobe Workfront support assistant for an internal MSP team at Chibitek.

Your goal is to give confident, thorough, and actionable answers to Workfront questions.

How to answer:
- Use your full knowledge of Adobe Workfront to provide the best possible answer.
- Use the INTERNAL CONTEXT below as supplementary information — it contains real conversations from our team that may have relevant tips, workflows, or team-specific processes.
- If the internal context contains useful team-specific details (like who to contact, our specific processes, or past solutions), weave those into your answer naturally.
- If the internal context is not relevant to the question, ignore it and answer purely from your Workfront expertise.
- Be direct and confident. Give step-by-step instructions when applicable.
- Use numbered steps or bullet points for processes.
- NEVER reference or cite the internal context directly. Do not mention "internal discussions", "our logs", "slack", or any source URLs.
- Do NOT include any "Sources:" section.

INTERNAL CONTEXT (from team conversations):
${context}
${imageBase64 ? "\nThe user has attached a screenshot. Analyze the image carefully and incorporate what you see into your response. Describe any errors, UI elements, or issues visible in the screenshot." : ""}`;

    // Capture the session ID to send to the client
    const capturedSid = sid;

    // Stream the response using a ReadableStream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Send the sessionId as the first line so the client can capture it
          controller.enqueue(encoder.encode(`__SESSION__:${capturedSid}\n`));

          const userMsg: { role: string; content: string; images?: string[] } = {
            role: "user",
            content: message,
          };
          if (imageBase64) {
            userMsg.images = [imageBase64];
          }

          const response = await ollama.chat({
            model: OLLAMA_MODEL,
            messages: [
              { role: "system", content: systemPrompt },
              userMsg,
            ],
            stream: true,
          });

          let fullText = "";

          for await (const part of response) {
            const chunk = part.message.content;
            fullText += chunk;
            controller.enqueue(encoder.encode(chunk));
          }

          // Save the complete response to Supabase after streaming finishes
          const { error: insAsstErr } = await supabaseServer
            .from("chat_messages")
            .insert({ session_id: capturedSid, role: "assistant", content: fullText });

          if (insAsstErr) {
            console.error("Failed to save assistant message:", insAsstErr.message);
          }

          console.log("POST /api/chat stream complete");
          controller.close();
        } catch (err: any) {
          console.error("Streaming error:", err);
          controller.enqueue(encoder.encode(`\n\n__ERROR__:${err?.message || "Unknown streaming error"}`));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err: any) {
    console.error("POST /api/chat fatal error:", err);
    return Response.json(
      { error: err?.message || "Unknown server error" },
      { status: 500 }
    );
  }
}
