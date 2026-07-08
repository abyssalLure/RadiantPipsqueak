import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

type SetupStatus = {
  isConfigured: boolean;
};

type AudioRecordSummary = {
  id: number;
  voice: string;
  model: string;
  status: string;
  error?: string | null;
  charCount: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  createdAt: string;
  updatedAt: string;
};

type SnippetSummary = {
  id: number;
  title: string;
  content: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  versions: number;
  activeAudio?: AudioRecordSummary | null;
};

type GenerationEstimate = {
  charCount: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  estimatedDurationSeconds: number;
};

type ModelRate = {
  model: string;
  pricePer1mCharsUsd: number;
};

type UsageSummary = {
  totalGenerations: number;
  totalCharacters: number;
  totalEstimatedTokens: number;
  totalEstimatedCostUsd: number;
  modelRates: ModelRate[];
};

type UsageSettings = {
  monthlyBudgetUsd: number;
  monthlyCharLimit: number;
  hardStop: boolean;
  defaultReadingInstructions: string;
};

type UsageTimelinePoint = {
  date: string;
  generations: number;
  characters: number;
  estimatedCostUsd: number;
};

type UsageLimitStatus = {
  monthKey: string;
  monthCharacters: number;
  monthEstimatedCostUsd: number;
  projectedMonthCharacters: number;
  projectedMonthEstimatedCostUsd: number;
  isBudgetLimitEnabled: boolean;
  isCharLimitEnabled: boolean;
  isBlocked: boolean;
  warnings: string[];
};

const VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function splitParagraphs(text: string) {
  return text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function cycleVoice(currentVoice: string) {
  const index = VOICES.indexOf(currentVoice);
  return VOICES[(index + 1) % VOICES.length] ?? VOICES[0];
}

function MiniActionButton({
  label,
  symbol,
  onClick,
  disabled,
}: {
  label: string;
  symbol: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="mini-action-button" type="button" title={label} onClick={onClick} disabled={disabled}>
      <span aria-hidden="true">{symbol}</span>
      <small>{label}</small>
    </button>
  );
}

function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [isConfigured, setIsConfigured] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("Ready.");
  const [activeTab, setActiveTab] = useState<"studio" | "usage">("studio");
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [busy, setBusy] = useState(false);

  const [snippets, setSnippets] = useState<SnippetSummary[]>([]);
  const [selectedSnippetId, setSelectedSnippetId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [voice, setVoice] = useState("alloy");
  const [model, setModel] = useState("gpt-4o-mini-tts");
  const [readingInstructionsOverride, setReadingInstructionsOverride] = useState("");
  const [snippetAudioUrl, setSnippetAudioUrl] = useState("");
  const [voiceTestText, setVoiceTestText] = useState("Try a short line before generating the full readback.");
  const [voiceTestAudioUrl, setVoiceTestAudioUrl] = useState("");

  const [currentEstimate, setCurrentEstimate] = useState<GenerationEstimate | null>(null);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [usageSettings, setUsageSettings] = useState<UsageSettings>({
    monthlyBudgetUsd: 0,
    monthlyCharLimit: 0,
    hardStop: false,
    defaultReadingInstructions: "",
  });
  const [usageTimeline, setUsageTimeline] = useState<UsageTimelinePoint[]>([]);
  const [usageLimitStatus, setUsageLimitStatus] = useState<UsageLimitStatus | null>(null);
  const [savingUsageSettings, setSavingUsageSettings] = useState(false);

  const selectedSnippet = snippets.find((snippet) => snippet.id === selectedSnippetId) ?? null;
  const sessionParagraphs = splitParagraphs(content);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    void refreshEstimate();
  }, [content, model]);

  async function bootstrap() {
    setIsLoading(true);
    setErrorMessage("");
    try {
      const status = await invoke<SetupStatus>("get_setup_status");
      setIsConfigured(status.isConfigured);
      if (status.isConfigured) {
        await refreshSnippets();
        await refreshUsageData();
      }
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshSnippets() {
    const items = await invoke<SnippetSummary[]>("list_snippets");
    setSnippets(items);

    if (items.length === 0) {
      setSelectedSnippetId(null);
      return;
    }

    const activeId = selectedSnippetId ?? items[0].id;
    const target = items.find((item) => item.id === activeId) ?? items[0];
    setSelectedSnippetId(target.id);
    setTitle(target.title);
    setContent(target.content);

    if (target.activeAudio) {
      setVoice(target.activeAudio.voice);
      setModel(target.activeAudio.model);
    }
  }

  async function refreshUsageData() {
    const [summary, settings, timeline, limitStatus] = await Promise.all([
      invoke<UsageSummary>("get_usage_summary"),
      invoke<UsageSettings>("get_usage_settings"),
      invoke<UsageTimelinePoint[]>("get_usage_timeline", { days: 30 }),
      invoke<UsageLimitStatus>("get_usage_limit_status"),
    ]);

    setUsageSummary(summary);
    setUsageSettings(settings);
    setUsageTimeline(timeline);
    setUsageLimitStatus(limitStatus);
  }

  async function refreshEstimate() {
    try {
      const estimate = await invoke<GenerationEstimate>("estimate_generation", {
        text: content,
        model,
      });
      setCurrentEstimate(estimate);
    } catch (error) {
      setErrorMessage(String(error));
    }
  }

  async function openApiKeyPage() {
    try {
      await openUrl("https://platform.openai.com/api-keys");
    } catch (error) {
      setErrorMessage(`Unable to open browser link: ${String(error)}`);
    }
  }

  async function handleSaveApiKey() {
    if (!apiKey.trim()) {
      setErrorMessage("Paste your OpenAI API key before continuing.");
      return;
    }

    setSavingKey(true);
    setErrorMessage("");
    try {
      await invoke("save_api_key", { apiKey: apiKey.trim() });
      setIsConfigured(true);
      setApiKey("");
      setStatusMessage("API key saved. Ready to generate readbacks.");
      await refreshSnippets();
      await refreshUsageData();
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setSavingKey(false);
    }
  }

  function handleCreateNew() {
    setSelectedSnippetId(null);
    setTitle("");
    setContent("");
    setSnippetAudioUrl("");
    setStatusMessage("New snippet draft ready.");
  }

  function selectSnippet(snippet: SnippetSummary) {
    setSelectedSnippetId(snippet.id);
    setTitle(snippet.title);
    setContent(snippet.content);
    setSnippetAudioUrl("");
    if (snippet.activeAudio) {
      setVoice(snippet.activeAudio.voice);
      setModel(snippet.activeAudio.model);
    }
  }

  async function handleGenerate(forceRegenerate: boolean) {
    if (!content.trim()) {
      setErrorMessage("Add text content before generating audio.");
      return;
    }

    setBusy(true);
    setErrorMessage("");
    setStatusMessage(forceRegenerate ? "Regenerating audio..." : "Generating audio...");
    try {
      const generated = await invoke<SnippetSummary>("generate_audio", {
        request: {
          snippetId: selectedSnippetId,
          title,
          content,
          voice,
          model,
          readingInstructions:
            readingInstructionsOverride.trim() || usageSettings.defaultReadingInstructions,
          forceRegenerate,
        },
      });

      setSelectedSnippetId(generated.id);
      setTitle(generated.title);
      setContent(generated.content);
      setStatusMessage(forceRegenerate ? "Audio regenerated." : "Audio generated.");

      await refreshSnippets();
      await refreshUsageData();

      if (generated.activeAudio) {
        await playAudioRecord(generated.activeAudio.id, false);
      }
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function playAudioRecord(audioRecordId: number, updateStatus = true) {
    setBusy(true);
    setErrorMessage("");
    try {
      const dataUrl = await invoke<string>("get_audio_data_url", { audioRecordId });
      setSnippetAudioUrl(dataUrl);
      if (updateStatus) {
        setStatusMessage("Loaded audio for playback.");
      }
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runVoiceTest() {
    if (!voiceTestText.trim()) {
      setErrorMessage("Add preview text before running a voice test.");
      return;
    }

    setBusy(true);
    setErrorMessage("");
    setStatusMessage("Generating voice test...");
    try {
      const dataUrl = await invoke<string>("generate_voice_preview", {
        text: voiceTestText,
        voice,
        model,
      });
      setVoiceTestAudioUrl(dataUrl);
      setStatusMessage("Voice test ready.");
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveUsageSettings() {
    setSavingUsageSettings(true);
    setErrorMessage("");
    try {
      const saved = await invoke<UsageSettings>("save_usage_settings", {
        settings: {
          monthlyBudgetUsd: Number(usageSettings.monthlyBudgetUsd || 0),
          monthlyCharLimit: Number(usageSettings.monthlyCharLimit || 0),
          hardStop: usageSettings.hardStop,
          defaultReadingInstructions: usageSettings.defaultReadingInstructions,
        },
      });
      setUsageSettings(saved);
      await refreshUsageData();
      setStatusMessage("Usage settings saved.");
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setSavingUsageSettings(false);
    }
  }

  if (isLoading) {
    return <main className="app-shell">Loading workspace...</main>;
  }

  return (
    <main className="app-shell">
      <div className="star-map" aria-hidden="true" />

      {!isConfigured ? (
        <section className="onboarding-panel">
          <p>
            Paste your OpenAI API key once. It is stored locally in encrypted form and used for
            text-to-voice generation.
          </p>
          <label htmlFor="api-key">OpenAI API key</label>
          <input
            id="api-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder="sk-..."
          />
          <p className="key-help-row">
            Need a key?{" "}
            <a
              href="https://platform.openai.com/api-keys"
              className="key-help-link"
              onClick={(event) => {
                event.preventDefault();
                void openApiKeyPage();
              }}
            >
              Create one on OpenAI.
            </a>
          </p>
          <button onClick={handleSaveApiKey} disabled={savingKey}>
            {savingKey ? "Saving..." : "Save and Continue"}
          </button>
          {errorMessage && <p className="error-message">{errorMessage}</p>}
        </section>
      ) : (
        <section className="workspace-grid">
          <aside className="left-rail">
            <button
              className={activeTab === "studio" ? "rail-button active" : "rail-button"}
              onClick={() => setActiveTab("studio")}
              type="button"
            >
              <span>Studio</span>
            </button>
            <button
              className={activeTab === "usage" ? "rail-button active" : "rail-button"}
              onClick={() => setActiveTab("usage")}
              type="button"
            >
              <span>Usage</span>
            </button>
            <button className="rail-button" onClick={handleCreateNew} type="button">
              <span>New</span>
            </button>
            <button
              className="rail-button"
              onClick={() => {
                void refreshSnippets();
                void refreshUsageData();
              }}
              type="button"
            >
              <span>Sync</span>
            </button>

            <div className="rail-divider" />

            <div className="rail-list">
              <small>Sessions</small>
              {snippets.length === 0 ? (
                <p className="muted rail-empty">No sessions yet.</p>
              ) : (
                snippets.slice(0, 6).map((snippet) => (
                  <button
                    key={snippet.id}
                    className={snippet.id === selectedSnippetId ? "rail-session active" : "rail-session"}
                    onClick={() => selectSnippet(snippet)}
                    type="button"
                  >
                    <span>{snippet.title}</span>
                    <small>{snippet.versions}x</small>
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="main-feed">
            {activeTab === "studio" ? (
              <>
                <header className="feed-header">
                  <div>
                    <h1>Session feed</h1>
                    <p className="muted">Build one paragraph at a time. Each block keeps its own quick actions.</p>
                  </div>
                  <div className="feed-status">
                    <span>{statusMessage}</span>
                    <span>
                      {currentEstimate
                        ? `${formatNumber(currentEstimate.charCount)} chars · ${formatCurrency(currentEstimate.estimatedCostUsd)}`
                        : "Type to see an estimate."}
                    </span>
                  </div>
                </header>

                <section className="composer-card">
                  <label htmlFor="title">Session title</label>
                  <input
                    id="title"
                    value={title}
                    onChange={(event) => setTitle(event.currentTarget.value)}
                    placeholder="Chapter scene, dialog pass, narration draft..."
                  />

                  <label htmlFor="content">Submitted paragraph feed</label>
                  <textarea
                    id="content"
                    value={content}
                    onChange={(event) => setContent(event.currentTarget.value)}
                    placeholder="Paste one or more paragraphs here..."
                    rows={8}
                  />

                  <div className="controls-row compact">
                    <div>
                      <label htmlFor="voice">Voice</label>
                      <select id="voice" value={voice} onChange={(event) => setVoice(event.currentTarget.value)}>
                        {VOICES.map((voiceName) => (
                          <option key={voiceName} value={voiceName}>
                            {voiceName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="model">Model</label>
                      <select id="model" value={model} onChange={(event) => setModel(event.currentTarget.value)}>
                        {MODELS.map((modelName) => (
                          <option key={modelName} value={modelName}>
                            {modelName}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <label htmlFor="reading-instructions">Reading direction</label>
                  <textarea
                    id="reading-instructions"
                    value={readingInstructionsOverride}
                    onChange={(event) => setReadingInstructionsOverride(event.currentTarget.value)}
                    placeholder="Example: Read in a warm reflective tone, slightly slower pace, with gentle pauses at commas."
                    rows={3}
                  />
                  <p className="muted">Leave blank to use the default reading direction from Usage and Settings.</p>

                  <div className="action-row compact">
                    <button onClick={() => void handleGenerate(false)} disabled={busy}>
                      Submit
                    </button>
                    <button onClick={() => void handleGenerate(true)} disabled={busy || selectedSnippet === null}>
                      Regenerate
                    </button>
                    <button
                      onClick={() =>
                        selectedSnippet?.activeAudio ? void playAudioRecord(selectedSnippet.activeAudio.id) : undefined
                      }
                      disabled={busy || !selectedSnippet?.activeAudio}
                    >
                      Playback
                    </button>
                  </div>

                  <audio controls src={snippetAudioUrl} className="audio-player" />
                </section>

                <section className="session-feed">
                  {sessionParagraphs.length === 0 ? (
                    <div className="empty-feed">
                      <h2>No paragraphs yet</h2>
                      <p className="muted">Paste text above, then submit to see each paragraph appear here.</p>
                    </div>
                  ) : (
                    sessionParagraphs.map((paragraph, index) => (
                      <article className="paragraph-card" key={`${selectedSnippetId ?? "draft"}-${index}`}>
                        <div className="paragraph-meta">
                          <span>Paragraph {index + 1}</span>
                          <small>{formatNumber(paragraph.length)} chars</small>
                        </div>
                        <p>{paragraph}</p>
                        <div className="paragraph-actions">
                          <MiniActionButton
                            label="Play"
                            symbol="▶"
                            onClick={() => {
                              if (selectedSnippet?.activeAudio) {
                                void playAudioRecord(selectedSnippet.activeAudio.id);
                              }
                            }}
                            disabled={busy || !selectedSnippet?.activeAudio}
                          />
                          <MiniActionButton
                            label="Voice"
                            symbol="V"
                            onClick={() => {
                              setVoice(cycleVoice(voice));
                              setVoiceTestText(paragraph);
                            }}
                          />
                          <MiniActionButton
                            label="Test"
                            symbol="↻"
                            onClick={() => {
                              setVoiceTestText(paragraph);
                              void runVoiceTest();
                            }}
                            disabled={busy}
                          />
                          <MiniActionButton
                            label="Use"
                            symbol="↧"
                            onClick={() => {
                              setContent(paragraph);
                              setStatusMessage("Paragraph copied to the composer.");
                            }}
                          />
                        </div>
                      </article>
                    ))
                  )}
                </section>

                <section className="inline-utility-panel">
                  <div className="inline-utility-header">
                    <h2>Voice test</h2>
                    <p>Use a short line before generating the full readback.</p>
                  </div>
                  <div className="voice-test-row">
                    <textarea
                      value={voiceTestText}
                      onChange={(event) => setVoiceTestText(event.currentTarget.value)}
                      rows={3}
                    />
                    <div className="voice-test-actions">
                      <button onClick={() => void runVoiceTest()} disabled={busy}>
                        Run Voice Test
                      </button>
                      <audio controls src={voiceTestAudioUrl} className="audio-player" />
                    </div>
                  </div>
                </section>
              </>
            ) : (
              <section className="settings-tab-panel">
                <div className="usage-panel">
                  <h2>Usage Snapshot</h2>
                  <p className="muted">Estimates are approximate and based on character counts.</p>

                  <div className="usage-metric-grid">
                    <div>
                      <span>Total generations</span>
                      <strong>{formatNumber(usageSummary?.totalGenerations ?? 0)}</strong>
                    </div>
                    <div>
                      <span>Total characters</span>
                      <strong>{formatNumber(usageSummary?.totalCharacters ?? 0)}</strong>
                    </div>
                    <div>
                      <span>Estimated tokens</span>
                      <strong>{formatNumber(usageSummary?.totalEstimatedTokens ?? 0)}</strong>
                    </div>
                    <div>
                      <span>Estimated spend</span>
                      <strong>{formatCurrency(usageSummary?.totalEstimatedCostUsd ?? 0)}</strong>
                    </div>
                  </div>

                  <h2>Model rates</h2>
                  <div className="rate-list">
                    {(usageSummary?.modelRates ?? []).map((rate) => (
                      <div key={rate.model} className="rate-item">
                        <span>{rate.model}</span>
                        <strong>{formatCurrency(rate.pricePer1mCharsUsd)} / 1M chars</strong>
                      </div>
                    ))}
                  </div>

                  <h2 style={{ marginTop: "1rem" }}>Current month</h2>
                  <div className="usage-metric-grid">
                    <div>
                      <span>Characters</span>
                      <strong>{formatNumber(usageLimitStatus?.monthCharacters ?? 0)}</strong>
                    </div>
                    <div>
                      <span>Projected characters</span>
                      <strong>{formatNumber(usageLimitStatus?.projectedMonthCharacters ?? 0)}</strong>
                    </div>
                    <div>
                      <span>Month cost</span>
                      <strong>{formatCurrency(usageLimitStatus?.monthEstimatedCostUsd ?? 0)}</strong>
                    </div>
                    <div>
                      <span>Projected cost</span>
                      <strong>{formatCurrency(usageLimitStatus?.projectedMonthEstimatedCostUsd ?? 0)}</strong>
                    </div>
                  </div>

                  {usageLimitStatus?.warnings?.length ? (
                    <div className="limit-warning-box">
                      {usageLimitStatus.warnings.map((warning) => (
                        <p key={warning}>{warning}</p>
                      ))}
                    </div>
                  ) : null}

                  <h2 style={{ marginTop: "1rem" }}>Timeline</h2>
                  <div className="timeline-list">
                    {usageTimeline.length === 0 ? (
                      <div className="timeline-row">
                        <span>No usage history yet.</span>
                      </div>
                    ) : (
                      usageTimeline.map((point) => (
                        <div key={point.date} className="timeline-row">
                          <span>{point.date}</span>
                          <span>{formatNumber(point.generations)} generations</span>
                          <span>{formatNumber(point.characters)} chars</span>
                          <span>{formatCurrency(point.estimatedCostUsd)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="usage-panel">
                  <h2>Usage and Settings</h2>
                  <label htmlFor="monthly-budget">Monthly budget (USD)</label>
                  <input
                    id="monthly-budget"
                    type="number"
                    min="0"
                    step="0.01"
                    value={usageSettings.monthlyBudgetUsd}
                    onChange={(event) =>
                      setUsageSettings((current) => ({
                        ...current,
                        monthlyBudgetUsd: Number(event.currentTarget.value),
                      }))
                    }
                  />

                  <label htmlFor="monthly-chars">Monthly character limit</label>
                  <input
                    id="monthly-chars"
                    type="number"
                    min="0"
                    step="1"
                    value={usageSettings.monthlyCharLimit}
                    onChange={(event) =>
                      setUsageSettings((current) => ({
                        ...current,
                        monthlyCharLimit: Number(event.currentTarget.value),
                      }))
                    }
                  />

                  <label className="inline-toggle" htmlFor="hard-stop">
                    <input
                      id="hard-stop"
                      type="checkbox"
                      checked={usageSettings.hardStop}
                      onChange={(event) =>
                        setUsageSettings((current) => ({
                          ...current,
                          hardStop: event.currentTarget.checked,
                        }))
                      }
                    />
                    Hard stop when a limit is reached
                  </label>

                  <label htmlFor="default-reading-instructions">Default reading instructions</label>
                  <textarea
                    id="default-reading-instructions"
                    value={usageSettings.defaultReadingInstructions}
                    onChange={(event) =>
                      setUsageSettings((current) => ({
                        ...current,
                        defaultReadingInstructions: event.currentTarget.value,
                      }))
                    }
                    rows={6}
                    placeholder="Example: Read like a calm narrator with warm pacing and gentle pauses."
                  />

                  <button onClick={() => void handleSaveUsageSettings()} disabled={savingUsageSettings}>
                    {savingUsageSettings ? "Saving..." : "Save Settings"}
                  </button>

                  <div className="limit-warning-box" style={{ marginTop: "0.9rem" }}>
                    <p>
                      Month key: <strong>{usageLimitStatus?.monthKey ?? "-"}</strong>
                    </p>
                    <p>
                      Budget limit: <strong>{usageLimitStatus?.isBudgetLimitEnabled ? "Enabled" : "Disabled"}</strong>
                    </p>
                    <p>
                      Character limit: <strong>{usageLimitStatus?.isCharLimitEnabled ? "Enabled" : "Disabled"}</strong>
                    </p>
                    <p>
                      Blocked: <strong>{usageLimitStatus?.isBlocked ? "Yes" : "No"}</strong>
                    </p>
                  </div>
                </div>
              </section>
            )}
          </section>
        </section>
      )}

      {errorMessage ? <p className="error-message">{errorMessage}</p> : null}
    </main>
  );
}

export default App;