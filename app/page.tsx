"use client";

import { useState } from "react";

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);

  async function sendMessage() {
    const text = input.trim();
    if (!text) return;

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: text,
          sessionId,
        }),
      });

      const data = await res.json();

      if (data.sessionId) {
        setSessionId(data.sessionId);
      }

      if (data.answer) {
        setMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
      } else if (data.error) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${data.error}` },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Request failed." },
      ]);
    }
  }

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>
        Workfront AI Support
      </h1>
      <p style={{ marginBottom: 24, opacity: 0.7 }}>
        Internal support assistant for Workfront issues
      </p>

      <div
        style={{
          border: "1px solid #333",
          borderRadius: 12,
          padding: 16,
          minHeight: 400,
          marginBottom: 16,
        }}
      >
        {messages.length === 0 ? (
          <p style={{ opacity: 0.6 }}>
            Ask something like: “How do I fix a Fusion 401 error?”
          </p>
        ) : (
          messages.map((msg, i) => (
            <div key={i} style={{ marginBottom: 16 }}>
              <strong>{msg.role === "user" ? "You" : "AI"}:</strong>
              <div>{msg.content}</div>
            </div>
          ))
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendMessage();
          }}
          placeholder="Ask a Workfront question..."
          style={{
            flex: 1,
            padding: 12,
            borderRadius: 8,
            border: "1px solid #333",
          }}
        />
        <button
          onClick={sendMessage}
          style={{
            padding: "12px 16px",
            borderRadius: 8,
            border: "1px solid #333",
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </div>
    </main>
  );
}
