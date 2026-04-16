"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "@/app/components/AuthProvider";

type Message = {
  role: "user" | "assistant";
  content: string;
  image?: string; // data URL for display
};

export default function Home() {
  const { user, signOut, loading } = useAuth();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [attachedImage, setAttachedImage] = useState<{ dataUrl: string; base64: string; name: string } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  function scrollToBottom() {
    const el = messagesContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }

  useEffect(() => {
    if (!loading && user) {
      inputRef.current?.focus();
    }
  }, [loading, user]);

  // Process an image file into base64
  const processImageFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    if (file.size > 10 * 1024 * 1024) {
      alert("Image must be under 10MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      // Extract pure base64 (remove "data:image/png;base64," prefix)
      const base64 = dataUrl.split(",")[1];
      setAttachedImage({ dataUrl, base64, name: file.name });
    };
    reader.readAsDataURL(file);
  }, []);

  // Drag & drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const imageFile = Array.from(files).find((f) => f.type.startsWith("image/"));
      if (imageFile) {
        processImageFile(imageFile);
      }
    }
  }, [processImageFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processImageFile(file);
    }
    // Reset file input so the same file can be selected again
    e.target.value = "";
  }, [processImageFile]);

  async function sendMessage() {
    const text = input.trim();
    if ((!text && !attachedImage) || isTyping) return;

    setTimeout(scrollToBottom, 50);

    // Build user message with optional image
    const userMessage: Message = {
      role: "user",
      content: text || (attachedImage ? "What is shown in this screenshot?" : ""),
      ...(attachedImage ? { image: attachedImage.dataUrl } : {}),
    };

    const imageBase64 = attachedImage?.base64 || null;

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setAttachedImage(null);
    setIsTyping(true);

    // Add an empty assistant message that we'll fill incrementally
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage.content,
          sessionId,
          ...(imageBase64 ? { image: imageBase64 } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: `Error: ${data.error || "Request failed"}`,
          };
          return updated;
        });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let fullText = "";
      let sessionCaptured = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });

        // The first line contains the session ID
        if (!sessionCaptured && chunk.includes("__SESSION__:")) {
          const lines = chunk.split("\n");
          const sessionLine = lines.find((l: string) => l.startsWith("__SESSION__:"));
          if (sessionLine) {
            const newSid = sessionLine.replace("__SESSION__:", "");
            setSessionId(newSid);
            sessionCaptured = true;
            const rest = lines.filter((l: string) => !l.startsWith("__SESSION__:")).join("\n");
            if (rest) {
              fullText += rest;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: fullText,
                };
                return updated;
              });
            }
            continue;
          }
        }

        // Check for error marker
        if (chunk.includes("__ERROR__:")) {
          const errorMsg = chunk.split("__ERROR__:")[1] || "Unknown error";
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: `Error: ${errorMsg}`,
            };
            return updated;
          });
          break;
        }

        fullText += chunk;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: fullText,
          };
          return updated;
        });
        setTimeout(scrollToBottom, 10);
      }
    } catch {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: "Request failed. Please try again.",
        };
        return updated;
      });
    } finally {
      setIsTyping(false);
    }
  }

  function handleNewChat() {
    setMessages([]);
    setSessionId(null);
    setAttachedImage(null);
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
    <div
      className="chat-page"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag & Drop Overlay */}
      {isDragging && (
        <div className="chat-drag-overlay">
          <div className="chat-drag-overlay-content">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <p>Drop your screenshot here</p>
            <span>PNG, JPG, GIF, or WebP — up to 10MB</span>
          </div>
        </div>
      )}

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
      <div className="chat-messages" id="chat-messages" ref={messagesContainerRef}>
        {messages.length === 0 && !isTyping ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h2>How can I help with Workfront?</h2>
            <p>Ask any question about Adobe Workfront — I'll search our internal knowledge base and provide an answer. You can also attach screenshots for analysis.</p>
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
                  {msg.image && (
                    <div className="chat-bubble-image">
                      <img src={msg.image} alt="Attached screenshot" />
                    </div>
                  )}
                  <div className="chat-bubble-text">
                    {msg.content || (isTyping && i === messages.length - 1) ? (
                      msg.content || <div className="typing-dots"><span /><span /><span /></div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}

          </>
        )}

      </div>

      {/* Input */}
      <div className="chat-input-bar" id="chat-input-bar">
        {/* Image Preview */}
        {attachedImage && (
          <div className="chat-image-preview">
            <div className="chat-image-preview-thumb">
              <img src={attachedImage.dataUrl} alt="Preview" />
              <button
                className="chat-image-preview-remove"
                onClick={() => setAttachedImage(null)}
                title="Remove image"
              >
                ×
              </button>
            </div>
            <span className="chat-image-preview-name">{attachedImage.name}</span>
          </div>
        )}

        <div className="chat-input-container">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />

          {/* Attach button */}
          <button
            className="chat-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={isTyping}
            title="Attach screenshot"
            id="attach-image-button"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </button>

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
            onPaste={(e) => {
              const items = e.clipboardData.items;
              for (let i = 0; i < items.length; i++) {
                if (items[i].type.startsWith("image/")) {
                  const file = items[i].getAsFile();
                  if (file) processImageFile(file);
                  break;
                }
              }
            }}
            placeholder={attachedImage ? "Describe what you need help with…" : "Ask a Workfront question…"}
            disabled={isTyping}
            autoComplete="off"
          />
          <button
            className="chat-send-btn"
            onClick={sendMessage}
            disabled={isTyping || (!input.trim() && !attachedImage)}
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
