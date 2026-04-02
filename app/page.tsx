"use client";

import { useState, useRef, useEffect } from "react";
import { useAuth } from "@/app/components/AuthProvider";

type Message = {
  role: "user" | "assistant";
  content: string;
};

export default function Home() {
  const { user, signOut, loading } = useAuth();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldAutoScroll = useRef(true);

  function handleScroll() {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScroll.current = distFromBottom < 100;
  }

  useEffect(() => {
    if (shouldAutoScroll.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isTyping]);

  useEffect(() => {
    if (!loading && user) {
      inputRef.current?.focus();
    }
  }, [loading, user]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || isTyping) return;

    shouldAutoScroll.current = true;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setIsTyping(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId }),
      });

      const data = await res.json();

      if (data.sessionId) setSessionId(data.sessionId);

      if (data.answer) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.answer },
        ]);
      } else if (data.error) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${data.error}` },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Request failed. Please try again." },
      ]);
    } finally {
      setIsTyping(false);
    }
  }

  function handleNewChat() {
    setMessages([]);
    setSessionId(null);
    inputRef.current?.focus();
  }

  if (loading) {
    return (
      <div className="chat-loading">
        <div className="typing-dots">
          <span /><span /><span />
        </div>
      </div>
    );
  }

  if (!user) return null;

  const userInitial = user.user_metadata?.full_name?.[0] ?? user.email?.[0] ?? "?";
  const userName = user.user_metadata?.full_name ?? user.email ?? "User";
  const userAvatar = user.user_metadata?.avatar_url;

  return (
    <div className="chat-page">
      {/* Header */}
      <header className="chat-header" id="chat-header">
        <div className="chat-header-left">
          <div className="chat-header-logo">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div>
            <h1 className="chat-header-title">Workfront AI</h1>
            <p className="chat-header-subtitle">Internal Support Assistant</p>
          </div>
        </div>
        <div className="chat-header-right">
          <button className="chat-new-btn" onClick={handleNewChat} title="New chat" id="new-chat-button">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Chat
          </button>
          <div className="chat-user-info">
            {userAvatar ? (
              <img src={userAvatar} alt={userName} className="chat-avatar" referrerPolicy="no-referrer" />
            ) : (
              <div className="chat-avatar chat-avatar-fallback">{userInitial.toUpperCase()}</div>
            )}
            <span className="chat-user-name">{userName}</span>
          </div>
          <button className="chat-signout-btn" onClick={signOut} id="sign-out-button">
            Sign Out
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className="chat-messages" id="chat-messages" ref={messagesContainerRef} onScroll={handleScroll}>
        {messages.length === 0 && !isTyping ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h2>How can I help with Workfront?</h2>
            <p>Ask any question about Adobe Workfront — I'll search our internal knowledge base and provide an answer.</p>
            <div className="chat-suggestions">
              {[
                "How do I fix a Fusion 401 error?",
                "How to set up a Workfront project template?",
                "What's our process for Workfront access requests?",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  className="chat-suggestion-btn"
                  onClick={() => {
                    setInput(suggestion);
                    inputRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`chat-bubble ${msg.role === "user" ? "chat-bubble-user" : "chat-bubble-ai"}`}
              >
                <div className="chat-bubble-avatar">
                  {msg.role === "user" ? (
                    userAvatar ? (
                      <img src={userAvatar} alt="" className="chat-bubble-avatar-img" referrerPolicy="no-referrer" />
                    ) : (
                      <span>{userInitial.toUpperCase()}</span>
                    )
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z" />
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    </svg>
                  )}
                </div>
                <div className="chat-bubble-content">
                  <div className="chat-bubble-role">
                    {msg.role === "user" ? "You" : "Workfront AI"}
                  </div>
                  <div className="chat-bubble-text">{msg.content}</div>
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="chat-bubble chat-bubble-ai">
                <div className="chat-bubble-avatar">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z" />
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  </svg>
                </div>
                <div className="chat-bubble-content">
                  <div className="chat-bubble-role">Workfront AI</div>
                  <div className="typing-dots">
                    <span /><span /><span />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="chat-input-bar" id="chat-input-bar">
        <div className="chat-input-container">
          <input
            ref={inputRef}
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Ask a Workfront question…"
            disabled={isTyping}
            autoComplete="off"
          />
          <button
            className="chat-send-btn"
            onClick={sendMessage}
            disabled={isTyping || !input.trim()}
            id="chat-send-button"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>

      <div className="chat-bg-glow chat-bg-glow-1" />
      <div className="chat-bg-glow chat-bg-glow-2" />
    </div>
  );
}
