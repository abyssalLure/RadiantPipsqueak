import { useEffect, useRef, useState } from "react";
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
  paragraphText?: string | null;
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
  paragraphAudio: AudioRecordSummary[];
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

type OpenMenu = "voice" | "model" | "session" | null;

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

function formatTime(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function splitParagraphs(text: string) {
  return text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function Wordmark() {
  return (
    <div className="wordmark">
      <span className="wordmark-ring" aria-hidden="true">
        <span className="wordmark-dot" />
      </span>
      <span className="wordmark-name">Radiant Pipsqueak</span>
    </div>
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
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);

  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [playingParagraph, setPlayingParagraph] = useState<number | null>(null);
  const [generatingParagraph, setGeneratingParagraph] = useState<number | null>(null);
  const [audioProgress, setAudioProgress] = useState({ current: 0, duration: 0 });
  const [knownDurations, setKnownDurations] = useState<Record<number, number>>({});

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
  const [settingsSaved, setSettingsSaved] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);
  const savedFlagTimer = useRef<number | null>(null);
  const audioUrlCache = useRef(new Map<number, string>());
  const voicePreviewCache = useRef(new Map<string, string>());
  const loadedRecordId = useRef<number | null>(null);
  // While generating, playback that catches up to a not-yet-voiced paragraph
  // parks its index here; the generation loop resumes it when the audio lands.
  const pendingPlayIndex = useRef<number | null>(null);

  const selectedSnippet = snippets.find((snippet) => snippet.id === selectedSnippetId) ?? null;
  const sessionParagraphs = splitParagraphs(content);

  // Each paragraph maps to its audio record for the current voice and model,
  // matched by exact text — editing a paragraph or switching voice makes it
  // "not generated" until that variant exists. Other voices' audio is kept, so
  // switching back is instant and free.
  const paragraphRecords = new Map<string, AudioRecordSummary>();
  for (const record of selectedSnippet?.paragraphAudio ?? []) {
    if (
      record.status === "generated" &&
      record.paragraphText &&
      record.voice === voice &&
      record.model === model
    ) {
      paragraphRecords.set(record.paragraphText, record);
    }
  }

  const totalParagraphChars = sessionParagraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);

  useEffect(() => {
    void bootstrap();
    return () => {
      if (savedFlagTimer.current !== null) {
        window.clearTimeout(savedFlagTimer.current);
      }
    };
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

  async function handleReplaceKey() {
    setErrorMessage("");
    try {
      await invoke("clear_api_key");
      setIsConfigured(false);
      setActiveTab("studio");
      setStatusMessage("API key removed. Paste a new key to continue.");
    } catch (error) {
      setErrorMessage(String(error));
    }
  }

  function stopPlayback() {
    pendingPlayIndex.current = null;
    audioRef.current?.pause();
    setPlayingParagraph(null);
    setAudioProgress({ current: 0, duration: 0 });
  }

  function handleCreateNew() {
    stopPlayback();
    setSelectedSnippetId(null);
    setTitle("");
    setContent("");
    setOpenMenu(null);
    setStatusMessage("New session draft ready.");
  }

  function selectSnippet(snippet: SnippetSummary) {
    stopPlayback();
    setSelectedSnippetId(snippet.id);
    setTitle(snippet.title);
    setContent(snippet.content);
    setOpenMenu(null);
    if (snippet.activeAudio) {
      setVoice(snippet.activeAudio.voice);
      setModel(snippet.activeAudio.model);
    }
  }

  function applySnippetSummary(summary: SnippetSummary) {
    setSelectedSnippetId(summary.id);
    setTitle(summary.title);
    setSnippets((current) => {
      const index = current.findIndex((snippet) => snippet.id === summary.id);
      if (index === -1) {
        return [summary, ...current];
      }
      const next = [...current];
      next[index] = summary;
      return next;
    });
  }

  async function requestParagraphAudio(
    paragraph: string,
    forceRegenerate: boolean,
    snippetId: number | null,
  ) {
    const summary = await invoke<SnippetSummary>("generate_paragraph_audio", {
      request: {
        snippetId,
        title,
        content,
        paragraphText: paragraph,
        voice,
        model,
        readingInstructions:
          readingInstructionsOverride.trim() || usageSettings.defaultReadingInstructions,
        forceRegenerate,
      },
    });
    applySnippetSummary(summary);
    return summary;
  }

  async function handleGenerateParagraph(index: number, forceRegenerate: boolean) {
    const paragraph = sessionParagraphs[index];
    if (!paragraph) {
      return;
    }

    setBusy(true);
    setGeneratingParagraph(index);
    setErrorMessage("");
    setStatusMessage(forceRegenerate ? "Regenerating paragraph..." : "Generating paragraph...");
    try {
      await requestParagraphAudio(paragraph, forceRegenerate, selectedSnippetId);
      await refreshUsageData();
      setStatusMessage(forceRegenerate ? "Paragraph regenerated." : "Paragraph readback ready.");
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setBusy(false);
      setGeneratingParagraph(null);
    }
  }

  async function handleGenerateAll() {
    if (sessionParagraphs.length === 0) {
      setErrorMessage("Add text content before generating audio.");
      return;
    }

    setBusy(true);
    setErrorMessage("");
    setStatusMessage("Generating readbacks...");
    let snippetId = selectedSnippetId;
    // Start reading from the top as soon as audio exists, unless the user is
    // already listening to something.
    let autoplayArmed = playingParagraph === null;
    pendingPlayIndex.current = null;
    try {
      if (autoplayArmed) {
        const firstRecord = paragraphRecords.get(sessionParagraphs[0]);
        if (firstRecord) {
          autoplayArmed = false;
          void playParagraph(0, firstRecord);
        }
      }

      for (let index = 0; index < sessionParagraphs.length; index += 1) {
        const paragraph = sessionParagraphs[index];
        if (paragraphRecords.has(paragraph)) {
          continue;
        }
        setGeneratingParagraph(index);
        const summary = await requestParagraphAudio(paragraph, false, snippetId);
        snippetId = summary.id;

        const record = summary.paragraphAudio.find(
          (candidate) =>
            candidate.paragraphText === paragraph &&
            candidate.voice === voice &&
            candidate.model === model,
        );
        if (record && autoplayArmed) {
          autoplayArmed = false;
          void playParagraph(index, record);
        } else if (record && pendingPlayIndex.current === index) {
          pendingPlayIndex.current = null;
          void playParagraph(index, record);
        }
      }
      await refreshUsageData();
      setStatusMessage("Readbacks generated.");
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setBusy(false);
      setGeneratingParagraph(null);
      pendingPlayIndex.current = null;
    }
  }

  async function playParagraph(index: number, record: AudioRecordSummary) {
    const audioElement = audioRef.current;
    if (!audioElement) {
      return;
    }

    try {
      let url = audioUrlCache.current.get(record.id);
      if (!url) {
        url = await invoke<string>("get_audio_data_url", { audioRecordId: record.id });
        audioUrlCache.current.set(record.id, url);
      }
      if (loadedRecordId.current !== record.id) {
        audioElement.src = url;
        loadedRecordId.current = record.id;
      }
      audioElement.currentTime = 0;
      await audioElement.play();
      setAudioProgress({ current: 0, duration: knownDurations[record.id] ?? 0 });
      setPlayingParagraph(index);
    } catch (error) {
      setErrorMessage(String(error));
      setPlayingParagraph(null);
    }
  }

  async function toggleParagraphPlayback(index: number, record: AudioRecordSummary) {
    if (playingParagraph === index) {
      stopPlayback();
      return;
    }
    await playParagraph(index, record);
  }

  async function previewVoice(voiceName: string) {
    const previewElement = previewAudioRef.current;
    if (!previewElement) {
      return;
    }

    setErrorMessage("");
    setPreviewingVoice(voiceName);
    try {
      const cacheKey = `${voiceName}|${model}`;
      let url = voicePreviewCache.current.get(cacheKey);
      if (!url) {
        url = await invoke<string>("generate_voice_preview", {
          text: `Hello, this is what ${voiceName} sounds like.`,
          voice: voiceName,
          model,
        });
        voicePreviewCache.current.set(cacheKey, url);
      }
      previewElement.src = url;
      await previewElement.play();
      // Re-assert: swapping src while a previous preview played fires 'pause',
      // which clears the indicator.
      setPreviewingVoice(voiceName);
      setStatusMessage(`Previewing the ${voiceName} voice.`);
    } catch (error) {
      setErrorMessage(String(error));
      setPreviewingVoice(null);
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
      setSettingsSaved(true);
      if (savedFlagTimer.current !== null) {
        window.clearTimeout(savedFlagTimer.current);
      }
      savedFlagTimer.current = window.setTimeout(() => setSettingsSaved(false), 1500);
    } catch (error) {
      setErrorMessage(String(error));
    } finally {
      setSavingUsageSettings(false);
    }
  }

  function paragraphDuration(paragraph: string) {
    if (!currentEstimate || totalParagraphChars === 0) {
      return 0;
    }
    return currentEstimate.estimatedDurationSeconds * (paragraph.length / totalParagraphChars);
  }

  function paragraphCost(paragraph: string) {
    if (!currentEstimate || currentEstimate.charCount === 0) {
      return null;
    }
    return (currentEstimate.estimatedCostUsd / currentEstimate.charCount) * paragraph.length;
  }

  if (isLoading) {
    return (
      <div className="app-viewport">
        <div className="loading-screen">Loading workspace…</div>
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="app-viewport">
        <div className="onboarding-screen">
          <div className="onboarding-card">
            <Wordmark />
            <h1 className="onboarding-headline">Bring your own voice.</h1>
            <p className="onboarding-copy">
              Paste your OpenAI API key once. It's stored locally in encrypted form and used only
              for text-to-speech generation.
            </p>
            <label className="field-label" htmlFor="api-key">
              OpenAI API key
            </label>
            <input
              id="api-key"
              className="key-input"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              placeholder="sk-..."
            />
            <p className="key-help">
              Need a key?{" "}
              <a
                href="https://platform.openai.com/api-keys"
                onClick={(event) => {
                  event.preventDefault();
                  void openApiKeyPage();
                }}
              >
                Create one on OpenAI.
              </a>
            </p>
            <button
              className="accent-button onboarding-save"
              onClick={() => void handleSaveApiKey()}
              disabled={savingKey}
              type="button"
            >
              {savingKey ? "Saving…" : "Save and continue"}
            </button>
          </div>
        </div>
        {errorMessage ? (
          <div className="error-toast" role="alert">
            <span>{errorMessage}</span>
            <button className="error-toast-dismiss" onClick={() => setErrorMessage("")} type="button">
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="app-viewport">
      <div className="app-shell">
        <header className="toolbar">
          <Wordmark />

          <div className="segmented" role="tablist">
            <button
              className={activeTab === "studio" ? "active" : ""}
              onClick={() => {
                setActiveTab("studio");
                setOpenMenu(null);
              }}
              type="button"
            >
              Studio
            </button>
            <button
              className={activeTab === "usage" ? "active" : ""}
              onClick={() => {
                setActiveTab("usage");
                setOpenMenu(null);
              }}
              type="button"
            >
              Usage
            </button>
          </div>

          <div className="toolbar-spacer" />

          {activeTab === "studio" ? (
            <div className="toolbar-controls">
              <div className="menu-anchor">
                <button
                  className="pill-button"
                  onClick={() => setOpenMenu(openMenu === "voice" ? null : "voice")}
                  type="button"
                >
                  <span className="pill-label">Voice</span>
                  <span className="pill-value">{voice}</span>
                  <span className="pill-chevron" aria-hidden="true">
                    ▾
                  </span>
                </button>
                {openMenu === "voice" ? (
                  <div className="dropdown-menu">
                    {VOICES.map((voiceName) => (
                      <button
                        key={voiceName}
                        className={voiceName === voice ? "menu-item selected" : "menu-item"}
                        onClick={() => {
                          setVoice(voiceName);
                          void previewVoice(voiceName);
                        }}
                        type="button"
                      >
                        {voiceName}
                        {previewingVoice === voiceName ? (
                          <span className="menu-item-note">playing</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="menu-anchor">
                <button
                  className="pill-button"
                  onClick={() => setOpenMenu(openMenu === "model" ? null : "model")}
                  type="button"
                >
                  <span className="pill-label">Model</span>
                  <span className="pill-value">{model}</span>
                  <span className="pill-chevron" aria-hidden="true">
                    ▾
                  </span>
                </button>
                {openMenu === "model" ? (
                  <div className="dropdown-menu model-menu">
                    {MODELS.map((modelName) => (
                      <button
                        key={modelName}
                        className={modelName === model ? "menu-item selected" : "menu-item"}
                        onClick={() => {
                          setModel(modelName);
                          setOpenMenu(null);
                        }}
                        type="button"
                      >
                        {modelName}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <button
                className="accent-button generate-button"
                onClick={() => void handleGenerateAll()}
                disabled={busy}
                type="button"
              >
                {busy ? "Working…" : "Generate"}
              </button>
            </div>
          ) : null}
        </header>

        {activeTab === "studio" ? (
          <div className="studio-grid">
            <section className="editor-pane rp-scroll">
              <div className="editor-header">
                <div className="menu-anchor">
                  <button
                    className="session-switcher"
                    onClick={() => setOpenMenu(openMenu === "session" ? null : "session")}
                    type="button"
                  >
                    <span className="micro-label">Session</span>
                    <span className="pill-chevron" aria-hidden="true">
                      ▾
                    </span>
                  </button>
                  {openMenu === "session" ? (
                    <div className="dropdown-menu session-menu">
                      {snippets.length === 0 ? (
                        <div className="session-empty">No sessions yet.</div>
                      ) : (
                        snippets.map((snippet) => (
                          <button
                            key={snippet.id}
                            className={
                              snippet.id === selectedSnippetId
                                ? "menu-item session-item selected"
                                : "menu-item session-item"
                            }
                            onClick={() => selectSnippet(snippet)}
                            type="button"
                          >
                            <span className="session-item-title">{snippet.title || "Untitled session"}</span>
                            <span className="session-item-meta">
                              {snippet.paragraphAudio.length}{" "}
                              {snippet.paragraphAudio.length === 1 ? "readback" : "readbacks"}
                            </span>
                          </button>
                        ))
                      )}
                      <div className="menu-divider" />
                      <button className="menu-item menu-new-session" onClick={handleCreateNew} type="button">
                        + New session
                      </button>
                    </div>
                  ) : null}
                </div>
                <span className="estimate-label">
                  {currentEstimate
                    ? `${formatNumber(currentEstimate.charCount)} chars · ~${formatCurrency(currentEstimate.estimatedCostUsd)}`
                    : "Type to see an estimate."}
                </span>
              </div>

              <input
                className="title-input"
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder="Untitled session"
                aria-label="Session title"
              />

              <textarea
                className="manuscript-input rp-scroll"
                value={content}
                onChange={(event) => setContent(event.currentTarget.value)}
                placeholder="Paste one or more paragraphs here. Separate them with a blank line — each becomes its own readback."
                aria-label="Manuscript"
              />

              <div className="direction-box">
                <span className="micro-label">Reading direction</span>
                <textarea
                  className="direction-input rp-scroll"
                  value={readingInstructionsOverride}
                  onChange={(event) => setReadingInstructionsOverride(event.currentTarget.value)}
                  placeholder="Leave blank to use the default from Usage & Settings."
                  aria-label="Reading direction"
                />
              </div>
            </section>

            <section className="readback-pane">
              <div className="readback-scroll rp-scroll">
                <div className="readback-header">
                  <span className="micro-label">Readback</span>
                  <span className="readback-header-right">
                    {sessionParagraphs.some((paragraph) => !paragraphRecords.has(paragraph)) ? (
                      <button
                        className="generate-all-link"
                        onClick={() => void handleGenerateAll()}
                        disabled={busy}
                        type="button"
                      >
                        Generate all
                      </button>
                    ) : null}
                    <span className="readback-count">
                      {sessionParagraphs.length} {sessionParagraphs.length === 1 ? "paragraph" : "paragraphs"}
                    </span>
                  </span>
                </div>

                {sessionParagraphs.length === 0 ? (
                  <div className="readback-empty">
                    <div className="readback-empty-title">Nothing to read yet</div>
                    <div className="readback-empty-hint">
                      Type in the manuscript on the left. Each paragraph appears here, ready to voice.
                    </div>
                  </div>
                ) : (
                  <div className="paragraph-list">
                    {sessionParagraphs.map((paragraph, index) => {
                      const record = paragraphRecords.get(paragraph) ?? null;
                      const isPlaying = playingParagraph === index;
                      const isGenerating = generatingParagraph === index;
                      const displaySeconds =
                        (record ? knownDurations[record.id] : undefined) ?? paragraphDuration(paragraph);
                      const costEstimate = record ? record.estimatedCostUsd : paragraphCost(paragraph);
                      const progressPct =
                        isPlaying && audioProgress.duration > 0
                          ? Math.min(100, (audioProgress.current / audioProgress.duration) * 100)
                          : 0;
                      return (
                        <article className="paragraph-card" key={`${selectedSnippetId ?? "draft"}-${index}`}>
                          <div className="paragraph-card-header">
                            <span className="micro-label">Paragraph {index + 1}</span>
                            <span className="paragraph-card-meta">
                              {record ? formatTime(displaySeconds) : "not generated"}
                              {costEstimate !== null
                                ? ` · ${record ? "" : "~"}${formatCurrency(costEstimate)}`
                                : ""}
                            </span>
                          </div>
                          <p className="paragraph-text">{paragraph}</p>
                          {record ? (
                            <div className="playback-row">
                              <button
                                className="play-button"
                                onClick={() => void toggleParagraphPlayback(index, record)}
                                disabled={busy && !isPlaying}
                                title={isPlaying ? "Pause" : "Play"}
                                type="button"
                              >
                                {isPlaying ? "❙❙" : "▶"}
                              </button>
                              <div className="progress-track">
                                <span className="progress-fill" style={{ width: `${progressPct}%` }} />
                              </div>
                              <span className="time-label">
                                {isPlaying
                                  ? `${formatTime(audioProgress.current)} / ${formatTime(audioProgress.duration)}`
                                  : `0:00 / ${formatTime(displaySeconds)}`}
                              </span>
                              <button
                                className="regen-button"
                                onClick={() => void handleGenerateParagraph(index, true)}
                                disabled={busy}
                                title="Regenerate"
                                type="button"
                              >
                                {isGenerating ? "…" : "↻"}
                              </button>
                            </div>
                          ) : (
                            <button
                              className="generate-readback-button"
                              onClick={() => void handleGenerateParagraph(index, false)}
                              disabled={busy}
                              type="button"
                            >
                              {isGenerating ? "Generating…" : "Generate readback"}
                            </button>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>

            </section>
          </div>
        ) : (
          <div className="usage-scroll rp-scroll">
            <div className="usage-grid">
              <div className="usage-column">
                <div>
                  <h2 className="panel-heading">Usage snapshot</h2>
                  <p className="panel-subline">Estimates are approximate, based on character counts.</p>
                  <div className="metric-grid">
                    <div className="metric-card">
                      <span className="micro-label">Generations</span>
                      <div className="metric-value">{formatNumber(usageSummary?.totalGenerations ?? 0)}</div>
                    </div>
                    <div className="metric-card">
                      <span className="micro-label">Characters</span>
                      <div className="metric-value">{formatNumber(usageSummary?.totalCharacters ?? 0)}</div>
                    </div>
                    <div className="metric-card">
                      <span className="micro-label">Est. tokens</span>
                      <div className="metric-value">{formatNumber(usageSummary?.totalEstimatedTokens ?? 0)}</div>
                    </div>
                    <div className="metric-card">
                      <span className="micro-label">Est. spend</span>
                      <div className="metric-value accent">
                        {formatCurrency(usageSummary?.totalEstimatedCostUsd ?? 0)}
                      </div>
                    </div>
                  </div>
                </div>

                {usageLimitStatus?.warnings?.length ? (
                  <div className="warning-card">
                    {usageLimitStatus.warnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </div>
                ) : null}

                <div>
                  <span className="micro-label list-label">Model rates</span>
                  <div className="list-card">
                    {(usageSummary?.modelRates ?? []).map((rate) => (
                      <div key={rate.model} className="rate-row">
                        <span className="rate-row-model">{rate.model}</span>
                        <span className="rate-row-price">
                          {formatCurrency(rate.pricePer1mCharsUsd)} / 1M chars
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="micro-label list-label">Last 4 days</span>
                  <div className="list-card">
                    {usageTimeline.length === 0 ? (
                      <div className="timeline-empty">No usage history yet.</div>
                    ) : (
                      usageTimeline
                        .slice(-4)
                        .reverse()
                        .map((point) => (
                          <div key={point.date} className="timeline-row">
                            <span className="timeline-date">{point.date}</span>
                            <span className="timeline-figure">{formatNumber(point.characters)} chars</span>
                            <span className="timeline-figure">{formatCurrency(point.estimatedCostUsd)}</span>
                          </div>
                        ))
                    )}
                  </div>
                </div>
              </div>

              <div className="settings-card">
                <h2 className="panel-heading">Usage &amp; settings</h2>

                <label className="field-label" htmlFor="monthly-budget">
                  Monthly budget (USD)
                </label>
                <input
                  id="monthly-budget"
                  className="settings-input"
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

                <label className="field-label" htmlFor="monthly-chars">
                  Monthly character limit
                </label>
                <input
                  id="monthly-chars"
                  className="settings-input"
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

                <label className="checkbox-row" htmlFor="hard-stop">
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
                  <span>Hard stop when a limit is reached</span>
                </label>

                <label className="field-label" htmlFor="default-reading-instructions">
                  Default reading direction
                </label>
                <textarea
                  id="default-reading-instructions"
                  className="settings-textarea rp-scroll"
                  value={usageSettings.defaultReadingInstructions}
                  onChange={(event) =>
                    setUsageSettings((current) => ({
                      ...current,
                      defaultReadingInstructions: event.currentTarget.value,
                    }))
                  }
                  placeholder="Example: Read like a calm narrator with warm pacing and gentle pauses."
                />

                <button
                  className="accent-button save-settings-button"
                  onClick={() => void handleSaveUsageSettings()}
                  disabled={savingUsageSettings}
                  type="button"
                >
                  {savingUsageSettings ? "Saving…" : settingsSaved ? "Saved ✓" : "Save settings"}
                </button>

                <div className="key-footer">
                  <div>
                    <div className="key-footer-title">API key</div>
                    <div className="key-footer-status">
                      <span className="key-status-dot" aria-hidden="true" />
                      Connected · stored locally
                    </div>
                  </div>
                  <button className="outline-button" onClick={() => void handleReplaceKey()} type="button">
                    Replace key
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {openMenu ? <div className="menu-backdrop" onClick={() => setOpenMenu(null)} /> : null}

      <audio
        ref={audioRef}
        onLoadedMetadata={(event) => {
          const duration = event.currentTarget.duration;
          const recordId = loadedRecordId.current;
          if (recordId !== null && Number.isFinite(duration)) {
            setKnownDurations((current) => ({ ...current, [recordId]: duration }));
          }
        }}
        onTimeUpdate={(event) =>
          setAudioProgress({
            current: event.currentTarget.currentTime,
            duration: event.currentTarget.duration || 0,
          })
        }
        onEnded={() => {
          setAudioProgress({ current: 0, duration: 0 });
          // Continue into the next paragraph when its audio is current; if it's
          // still being generated, park the index for the loop to resume.
          const nextIndex = playingParagraph === null ? null : playingParagraph + 1;
          const nextParagraph = nextIndex === null ? undefined : sessionParagraphs[nextIndex];
          const nextRecord = nextParagraph ? paragraphRecords.get(nextParagraph) : undefined;
          if (nextIndex !== null && nextRecord) {
            void playParagraph(nextIndex, nextRecord);
            return;
          }
          if (nextIndex !== null && nextParagraph && busy) {
            pendingPlayIndex.current = nextIndex;
          }
          setPlayingParagraph(null);
        }}
      />
      <audio
        ref={previewAudioRef}
        onEnded={() => setPreviewingVoice(null)}
        onPause={() => setPreviewingVoice(null)}
      />

      <div className="visually-hidden" role="status" aria-live="polite">
        {statusMessage}
      </div>

      {errorMessage ? (
        <div className="error-toast" role="alert">
          <span>{errorMessage}</span>
          <button className="error-toast-dismiss" onClick={() => setErrorMessage("")} type="button">
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default App;
