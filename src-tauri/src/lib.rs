use aes_gcm_siv::aead::{Aead, KeyInit, OsRng};
use aes_gcm_siv::aead::rand_core::RngCore;
use aes_gcm_siv::{Aes256GcmSiv, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chrono::{Duration, Utc};
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const DEFAULT_MODEL: &str = "gpt-4o-mini-tts";
const DEFAULT_VOICE: &str = "alloy";
// OpenAI's /v1/audio/speech rejects inputs longer than this.
const OPENAI_TTS_CHAR_LIMIT: i64 = 4096;
const DEFAULT_SECTION_CHAR_TARGET: i64 = 3500;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationEstimate {
    char_count: i64,
    estimated_tokens: i64,
    estimated_cost_usd: f64,
    price_per_1m_chars_usd: f64,
    estimated_duration_seconds: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelRate {
    model: String,
    price_per_1m_chars_usd: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    total_generations: i64,
    total_characters: i64,
    total_estimated_tokens: i64,
    total_estimated_cost_usd: f64,
    model_rates: Vec<ModelRate>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UsageSettings {
    monthly_budget_usd: f64,
    monthly_char_limit: i64,
    hard_stop: bool,
    default_reading_instructions: String,
    section_char_target: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageTimelinePoint {
    date: String,
    generations: i64,
    characters: i64,
    estimated_cost_usd: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageLimitStatus {
    month_key: String,
    month_characters: i64,
    month_estimated_cost_usd: f64,
    projected_month_characters: i64,
    projected_month_estimated_cost_usd: f64,
    is_budget_limit_enabled: bool,
    is_char_limit_enabled: bool,
    is_blocked: bool,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStatus {
    is_configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioRecordSummary {
    id: i64,
    voice: String,
    model: String,
    status: String,
    error: Option<String>,
    char_count: i64,
    estimated_tokens: i64,
    estimated_cost_usd: f64,
    created_at: String,
    updated_at: String,
    paragraph_text: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnippetSummary {
    id: i64,
    title: String,
    content: String,
    content_hash: String,
    created_at: String,
    updated_at: String,
    versions: i64,
    active_audio: Option<AudioRecordSummary>,
    paragraph_audio: Vec<AudioRecordSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateParagraphRequest {
    snippet_id: Option<i64>,
    title: Option<String>,
    content: String,
    paragraph_text: String,
    voice: Option<String>,
    model: Option<String>,
    reading_instructions: Option<String>,
    force_regenerate: Option<bool>,
}

#[derive(Serialize, Deserialize)]
struct EncryptedPayload {
    salt: String,
    nonce: String,
    ciphertext: String,
}

#[tauri::command]
fn get_setup_status(app: AppHandle) -> Result<SetupStatus, String> {
    ensure_storage(&app)?;
    let is_configured = read_api_key(&app).is_ok();
    Ok(SetupStatus { is_configured })
}

#[tauri::command]
fn estimate_generation(text: String, model: Option<String>) -> Result<GenerationEstimate, String> {
    let model_name = model
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
        .trim()
        .to_string();
    Ok(compute_estimate(&text, &model_name))
}

#[tauri::command]
fn get_usage_summary(app: AppHandle) -> Result<UsageSummary, String> {
    ensure_storage(&app)?;
    let conn = db_connection(&app)?;

    let (total_generations, total_characters, total_estimated_tokens, total_estimated_cost_usd) = conn
        .query_row(
            "
            SELECT
              COUNT(1),
              COALESCE(SUM(char_count), 0),
              COALESCE(SUM(estimated_tokens), 0),
              COALESCE(SUM(estimated_cost_usd), 0.0)
            FROM audio_records
            WHERE status = 'generated'
            ",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            },
        )
        .map_err(|e| format!("Failed to build usage summary: {e}"))?;

    let model_rates = vec![
        ModelRate {
            model: "gpt-4o-mini-tts".to_string(),
            price_per_1m_chars_usd: model_price_per_1m_chars("gpt-4o-mini-tts"),
        },
        ModelRate {
            model: "tts-1".to_string(),
            price_per_1m_chars_usd: model_price_per_1m_chars("tts-1"),
        },
        ModelRate {
            model: "tts-1-hd".to_string(),
            price_per_1m_chars_usd: model_price_per_1m_chars("tts-1-hd"),
        },
    ];

    Ok(UsageSummary {
        total_generations,
        total_characters,
        total_estimated_tokens,
        total_estimated_cost_usd,
        model_rates,
    })
}

#[tauri::command]
fn get_usage_settings(app: AppHandle) -> Result<UsageSettings, String> {
    ensure_storage(&app)?;
    let conn = db_connection(&app)?;
    load_usage_settings(&conn)
}

#[tauri::command]
fn save_usage_settings(app: AppHandle, settings: UsageSettings) -> Result<UsageSettings, String> {
    ensure_storage(&app)?;
    let conn = db_connection(&app)?;

    let budget = if settings.monthly_budget_usd.is_sign_negative() {
        0.0
    } else {
        settings.monthly_budget_usd
    };
    let chars = if settings.monthly_char_limit < 0 {
        0
    } else {
        settings.monthly_char_limit
    };
    let instructions = settings.default_reading_instructions.trim().to_string();
    let section_target = settings.section_char_target.clamp(0, OPENAI_TTS_CHAR_LIMIT);
    let now = now_iso();

    conn.execute(
        "INSERT INTO usage_settings (id, monthly_budget_usd, monthly_char_limit, hard_stop, default_reading_instructions, section_char_target, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           monthly_budget_usd = excluded.monthly_budget_usd,
           monthly_char_limit = excluded.monthly_char_limit,
           hard_stop = excluded.hard_stop,
           default_reading_instructions = excluded.default_reading_instructions,
           section_char_target = excluded.section_char_target,
           updated_at = excluded.updated_at",
        params![budget, chars, bool_to_i64(settings.hard_stop), instructions, section_target, now],
    )
    .map_err(|e| format!("Failed to save usage settings: {e}"))?;

    load_usage_settings(&conn)
}

#[tauri::command]
fn get_usage_timeline(app: AppHandle, days: Option<i64>) -> Result<Vec<UsageTimelinePoint>, String> {
    ensure_storage(&app)?;
    let conn = db_connection(&app)?;
    let day_count = days.unwrap_or(30).clamp(1, 365);
    let cutoff = (Utc::now() - Duration::days(day_count - 1))
        .format("%Y-%m-%d")
        .to_string();

    let mut points = Vec::new();
    let mut stmt = conn
        .prepare(
            "
            SELECT
              substr(created_at, 1, 10) AS day,
              COUNT(1) AS generations,
              COALESCE(SUM(char_count), 0) AS characters,
              COALESCE(SUM(estimated_cost_usd), 0.0) AS estimated_cost_usd
            FROM audio_records
            WHERE status = 'generated'
              AND day >= ?1
            GROUP BY day
            ORDER BY day ASC
            ",
        )
        .map_err(|e| format!("Failed to prepare timeline query: {e}"))?;

    let rows = stmt
        .query_map(params![cutoff], |row| {
            Ok(UsageTimelinePoint {
                date: row.get(0)?,
                generations: row.get(1)?,
                characters: row.get(2)?,
                estimated_cost_usd: row.get(3)?,
            })
        })
        .map_err(|e| format!("Failed to query usage timeline: {e}"))?;

    for row in rows {
        points.push(row.map_err(|e| format!("Failed to read timeline row: {e}"))?);
    }

    Ok(points)
}

#[tauri::command]
fn get_usage_limit_status(app: AppHandle) -> Result<UsageLimitStatus, String> {
    ensure_storage(&app)?;
    let conn = db_connection(&app)?;
    let settings = load_usage_settings(&conn)?;
    compute_limit_status(&conn, &settings, 0.0, 0)
}

#[tauri::command]
fn save_api_key(app: AppHandle, api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("API key cannot be empty".to_string());
    }

    ensure_storage(&app)?;
    let encrypted = encrypt_api_key(api_key.trim())?;
    let key_path = api_key_path(&app)?;
    fs::write(&key_path, encrypted).map_err(|e| format!("Failed to save API key: {e}"))?;
    Ok(())
}

#[tauri::command]
fn clear_api_key(app: AppHandle) -> Result<(), String> {
    let key_path = api_key_path(&app)?;
    if key_path.exists() {
        fs::remove_file(&key_path).map_err(|e| format!("Failed to remove API key: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn list_snippets(app: AppHandle) -> Result<Vec<SnippetSummary>, String> {
    ensure_storage(&app)?;
    let conn = db_connection(&app)?;

    let mut ids = Vec::new();
    let mut stmt = conn
        .prepare("SELECT id FROM snippets ORDER BY updated_at DESC")
        .map_err(|e| format!("Failed to prepare snippet query: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|e| format!("Failed to query snippets: {e}"))?;

    for row in rows {
        ids.push(row.map_err(|e| format!("Failed to read snippet row: {e}"))?);
    }

    let mut snippets = Vec::with_capacity(ids.len());
    for id in ids {
        snippets.push(get_snippet_summary(&conn, id)?);
    }
    Ok(snippets)
}

#[tauri::command]
async fn generate_paragraph_audio(
    app: AppHandle,
    request: GenerateParagraphRequest,
) -> Result<SnippetSummary, String> {
    ensure_storage(&app)?;
    let content = request.content.trim();
    if content.is_empty() {
        return Err("Text content is required".to_string());
    }
    let paragraph = request.paragraph_text.trim();
    if paragraph.is_empty() {
        return Err("Paragraph text is required".to_string());
    }
    if paragraph.chars().count() as i64 > OPENAI_TTS_CHAR_LIMIT {
        return Err(format!(
            "Section is longer than OpenAI's {OPENAI_TTS_CHAR_LIMIT} character limit; lower the section size in Usage & Settings"
        ));
    }

    let voice = request
        .voice
        .unwrap_or_else(|| DEFAULT_VOICE.to_string())
        .trim()
        .to_string();
    let model = request
        .model
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
        .trim()
        .to_string();
    let title = request
        .title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| derive_title(content))
        .trim()
        .to_string();
    let force_regenerate = request.force_regenerate.unwrap_or(false);
    let content_hash = hash_text(content);
    let paragraph_hash = hash_text(paragraph);
    let estimate = compute_estimate(paragraph, &model);

    let mut conn = db_connection(&app)?;
    let settings = load_usage_settings(&conn)?;
    let reading_instructions = request
        .reading_instructions
        .unwrap_or_else(|| settings.default_reading_instructions.clone());

    let now = now_iso();
    let snippet_id = upsert_snippet(
        &mut conn,
        request.snippet_id,
        &title,
        content,
        &content_hash,
        &now,
    )?;

    if !force_regenerate {
        if let Some((record_id, is_active)) =
            find_paragraph_audio(&conn, snippet_id, &paragraph_hash, &voice, &model)?
        {
            if !is_active {
                reactivate_paragraph_audio(&mut conn, snippet_id, &paragraph_hash, &voice, &model, record_id)?;
            }
            return get_snippet_summary(&conn, snippet_id);
        }
    }

    let projected = compute_limit_status(&conn, &settings, estimate.estimated_cost_usd, estimate.char_count)?;
    if projected.is_blocked && settings.hard_stop {
        let reason = projected
            .warnings
            .first()
            .cloned()
            .unwrap_or_else(|| "Usage limit reached".to_string());
        return Err(format!("Generation blocked by usage settings: {reason}"));
    }

    let api_key = read_api_key(&app)?;
    let bytes = call_openai_tts(
        &api_key,
        paragraph,
        &voice,
        &model,
        Some(reading_instructions.trim()),
    )
    .await?;
    let audio_path = save_audio_file(&app, snippet_id, &voice, &model, &paragraph_hash, &bytes)?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to open database transaction: {e}"))?;
    tx.execute(
        "UPDATE audio_records SET is_active = 0
         WHERE snippet_id = ?1 AND paragraph_hash = ?2 AND voice = ?3 AND model = ?4",
        params![snippet_id, paragraph_hash, voice, model],
    )
    .map_err(|e| format!("Failed to deactivate old paragraph audio: {e}"))?;

    tx.execute(
        "INSERT INTO audio_records (snippet_id, voice, model, audio_path, status, error, char_count, estimated_tokens, estimated_cost_usd, is_active, created_at, updated_at, paragraph_hash, paragraph_text)
         VALUES (?1, ?2, ?3, ?4, 'generated', NULL, ?5, ?6, ?7, 1, ?8, ?8, ?9, ?10)",
        params![snippet_id, voice, model, audio_path, estimate.char_count, estimate.estimated_tokens, estimate.estimated_cost_usd, now, paragraph_hash, paragraph],
    )
    .map_err(|e| format!("Failed to insert new audio record: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit audio generation: {e}"))?;

    get_snippet_summary(&conn, snippet_id)
}

#[tauri::command]
async fn generate_voice_preview(
    app: AppHandle,
    text: String,
    voice: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let api_key = read_api_key(&app)?;
    let conn = db_connection(&app)?;
    let settings = load_usage_settings(&conn)?;
    let preview_text = text.trim();
    if preview_text.is_empty() {
        return Err("Preview text cannot be empty".to_string());
    }

    let voice_value = voice.unwrap_or_else(|| DEFAULT_VOICE.to_string());
    let model_value = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let bytes = call_openai_tts(
        &api_key,
        preview_text,
        &voice_value,
        &model_value,
        Some(settings.default_reading_instructions.trim()),
    )
    .await?;
    Ok(format!("data:audio/mpeg;base64,{}", B64.encode(bytes)))
}

#[tauri::command]
fn get_audio_data_url(app: AppHandle, audio_record_id: i64) -> Result<String, String> {
    let conn = db_connection(&app)?;
    let relative_path = conn
        .query_row(
            "SELECT audio_path FROM audio_records WHERE id = ?1",
            params![audio_record_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("Audio record not found: {e}"))?;

    let full_path = audio_root(&app)?.join(&relative_path);
    let bytes = fs::read(&full_path)
        .map_err(|e| format!("Unable to read audio file at {}: {e}", full_path.display()))?;
    Ok(format!("data:audio/mpeg;base64,{}", B64.encode(bytes)))
}

fn ensure_storage(app: &AppHandle) -> Result<(), String> {
    fs::create_dir_all(config_root(app)?)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;
    fs::create_dir_all(data_root(app)?).map_err(|e| format!("Failed to create data directory: {e}"))?;
    fs::create_dir_all(audio_root(app)?)
        .map_err(|e| format!("Failed to create audio directory: {e}"))?;

    let conn = db_connection(app)?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS snippets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audio_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snippet_id INTEGER NOT NULL,
            voice TEXT NOT NULL,
            model TEXT NOT NULL,
            audio_path TEXT NOT NULL,
            status TEXT NOT NULL,
            error TEXT,
            char_count INTEGER NOT NULL DEFAULT 0,
            estimated_tokens INTEGER NOT NULL DEFAULT 0,
            estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            paragraph_hash TEXT,
            paragraph_text TEXT,
            FOREIGN KEY (snippet_id) REFERENCES snippets(id)
        );

        CREATE INDEX IF NOT EXISTS idx_snippets_hash ON snippets(content_hash);
        CREATE INDEX IF NOT EXISTS idx_audio_records_snippet ON audio_records(snippet_id);
        CREATE INDEX IF NOT EXISTS idx_audio_records_active ON audio_records(is_active);

        CREATE TABLE IF NOT EXISTS usage_settings (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            monthly_budget_usd REAL NOT NULL DEFAULT 0.0,
            monthly_char_limit INTEGER NOT NULL DEFAULT 0,
            hard_stop INTEGER NOT NULL DEFAULT 1,
            default_reading_instructions TEXT NOT NULL DEFAULT '',
            section_char_target INTEGER NOT NULL DEFAULT 3500,
            updated_at TEXT NOT NULL
        );
        ",
    )
    .map_err(|e| format!("Failed to initialize database schema: {e}"))?;

    ensure_audio_records_migrations(&conn)?;
    ensure_usage_settings_seed(&conn)?;

    Ok(())
}

fn ensure_usage_settings_seed(conn: &Connection) -> Result<(), String> {
    let now = now_iso();
    conn.execute(
        "INSERT OR IGNORE INTO usage_settings (id, monthly_budget_usd, monthly_char_limit, hard_stop, default_reading_instructions, updated_at)
         VALUES (1, 0.0, 0, 1, '', ?1)",
        params![now],
    )
    .map_err(|e| format!("Failed to seed usage settings: {e}"))?;

    let mut has_default_instructions = false;
    let mut has_section_target = false;
    let mut stmt = conn
        .prepare("PRAGMA table_info(usage_settings)")
        .map_err(|e| format!("Failed to inspect usage_settings schema: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to inspect usage_settings columns: {e}"))?;
    for row in rows {
        let column = row.map_err(|e| format!("Failed to read usage_settings column info: {e}"))?;
        if column == "default_reading_instructions" {
            has_default_instructions = true;
        }
        if column == "section_char_target" {
            has_section_target = true;
        }
    }

    if !has_default_instructions {
        conn.execute(
            "ALTER TABLE usage_settings ADD COLUMN default_reading_instructions TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| format!("Failed to migrate usage_settings.default_reading_instructions: {e}"))?;
    }

    if !has_section_target {
        conn.execute(
            &format!(
                "ALTER TABLE usage_settings ADD COLUMN section_char_target INTEGER NOT NULL DEFAULT {DEFAULT_SECTION_CHAR_TARGET}"
            ),
            [],
        )
        .map_err(|e| format!("Failed to migrate usage_settings.section_char_target: {e}"))?;
    }

    Ok(())
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn load_usage_settings(conn: &Connection) -> Result<UsageSettings, String> {
    conn.query_row(
        "SELECT monthly_budget_usd, monthly_char_limit, hard_stop, default_reading_instructions, section_char_target FROM usage_settings WHERE id = 1",
        [],
        |row| {
            let hard_stop_flag: i64 = row.get(2)?;
            Ok(UsageSettings {
                monthly_budget_usd: row.get(0)?,
                monthly_char_limit: row.get(1)?,
                hard_stop: hard_stop_flag == 1,
                default_reading_instructions: row.get(3)?,
                section_char_target: row.get(4)?,
            })
        },
    )
    .map_err(|e| format!("Failed to load usage settings: {e}"))
}

fn current_month_usage(conn: &Connection) -> Result<(String, i64, f64), String> {
    let month_key = Utc::now().format("%Y-%m").to_string();
    let (chars, cost) = conn
        .query_row(
            "
            SELECT
              COALESCE(SUM(char_count), 0),
              COALESCE(SUM(estimated_cost_usd), 0.0)
            FROM audio_records
            WHERE status = 'generated'
              AND substr(created_at, 1, 7) = ?1
            ",
            params![month_key],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)),
        )
        .map_err(|e| format!("Failed to compute monthly usage: {e}"))?;

    Ok((month_key, chars, cost))
}

fn compute_limit_status(
    conn: &Connection,
    settings: &UsageSettings,
    additional_cost_usd: f64,
    additional_chars: i64,
) -> Result<UsageLimitStatus, String> {
    let (month_key, month_characters, month_estimated_cost_usd) = current_month_usage(conn)?;
    let projected_month_characters = month_characters + additional_chars;
    let projected_month_estimated_cost_usd = month_estimated_cost_usd + additional_cost_usd;

    let is_budget_limit_enabled = settings.monthly_budget_usd > 0.0;
    let is_char_limit_enabled = settings.monthly_char_limit > 0;
    let mut warnings = Vec::new();

    if is_budget_limit_enabled && projected_month_estimated_cost_usd > settings.monthly_budget_usd {
        warnings.push(format!(
            "Projected monthly cost ${:.6} exceeds budget limit ${:.6}",
            projected_month_estimated_cost_usd, settings.monthly_budget_usd
        ));
    }

    if is_char_limit_enabled && projected_month_characters > settings.monthly_char_limit {
        warnings.push(format!(
            "Projected monthly character usage {} exceeds limit {}",
            projected_month_characters, settings.monthly_char_limit
        ));
    }

    Ok(UsageLimitStatus {
        month_key,
        month_characters,
        month_estimated_cost_usd,
        projected_month_characters,
        projected_month_estimated_cost_usd,
        is_budget_limit_enabled,
        is_char_limit_enabled,
        is_blocked: !warnings.is_empty(),
        warnings,
    })
}

fn ensure_audio_records_migrations(conn: &Connection) -> Result<(), String> {
    let mut has_char_count = false;
    let mut has_estimated_tokens = false;
    let mut has_estimated_cost = false;
    let mut has_paragraph_hash = false;

    let mut stmt = conn
        .prepare("PRAGMA table_info(audio_records)")
        .map_err(|e| format!("Failed to inspect audio_records schema: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to inspect columns: {e}"))?;

    for row in rows {
        let column = row.map_err(|e| format!("Failed to read column info: {e}"))?;
        if column == "char_count" {
            has_char_count = true;
        }
        if column == "estimated_tokens" {
            has_estimated_tokens = true;
        }
        if column == "estimated_cost_usd" {
            has_estimated_cost = true;
        }
        if column == "paragraph_hash" {
            has_paragraph_hash = true;
        }
    }

    if !has_char_count {
        conn.execute(
            "ALTER TABLE audio_records ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("Failed to migrate audio_records.char_count: {e}"))?;
    }
    if !has_estimated_tokens {
        conn.execute(
            "ALTER TABLE audio_records ADD COLUMN estimated_tokens INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("Failed to migrate audio_records.estimated_tokens: {e}"))?;
    }
    if !has_estimated_cost {
        conn.execute(
            "ALTER TABLE audio_records ADD COLUMN estimated_cost_usd REAL NOT NULL DEFAULT 0.0",
            [],
        )
        .map_err(|e| format!("Failed to migrate audio_records.estimated_cost_usd: {e}"))?;
    }
    if !has_paragraph_hash {
        conn.execute("ALTER TABLE audio_records ADD COLUMN paragraph_hash TEXT", [])
            .map_err(|e| format!("Failed to migrate audio_records.paragraph_hash: {e}"))?;
        conn.execute("ALTER TABLE audio_records ADD COLUMN paragraph_text TEXT", [])
            .map_err(|e| format!("Failed to migrate audio_records.paragraph_text: {e}"))?;
        backfill_single_paragraph_audio(conn)?;
    }

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_audio_records_paragraph ON audio_records(snippet_id, paragraph_hash)",
        [],
    )
    .map_err(|e| format!("Failed to create paragraph audio index: {e}"))?;

    Ok(())
}

// Whole-snippet audio from before per-paragraph generation stays usable when
// the snippet is a single paragraph; multi-paragraph audio can't be attributed
// to one paragraph and is left as inactive history.
fn backfill_single_paragraph_audio(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id, content FROM snippets")
        .map_err(|e| format!("Failed to prepare snippet backfill query: {e}"))?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| format!("Failed to query snippets for backfill: {e}"))?;

    let mut single_paragraph_snippets = Vec::new();
    for row in rows {
        let (id, content) = row.map_err(|e| format!("Failed to read snippet for backfill: {e}"))?;
        let paragraphs = split_paragraphs(&content);
        if paragraphs.len() == 1 {
            single_paragraph_snippets.push((id, paragraphs.into_iter().next().unwrap()));
        }
    }

    for (snippet_id, paragraph) in single_paragraph_snippets {
        conn.execute(
            "UPDATE audio_records SET paragraph_hash = ?1, paragraph_text = ?2
             WHERE snippet_id = ?3 AND is_active = 1 AND paragraph_hash IS NULL AND status = 'generated'",
            params![hash_text(&paragraph), paragraph, snippet_id],
        )
        .map_err(|e| format!("Failed to backfill paragraph audio: {e}"))?;
    }

    Ok(())
}

fn db_connection(app: &AppHandle) -> Result<Connection, String> {
    ensure_storage_dirs_only(app)?;
    let db_path = db_path(app)?;
    Connection::open(db_path).map_err(|e| format!("Failed to open database: {e}"))
}

fn ensure_storage_dirs_only(app: &AppHandle) -> Result<(), String> {
    fs::create_dir_all(config_root(app)?)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;
    fs::create_dir_all(data_root(app)?).map_err(|e| format!("Failed to create data directory: {e}"))?;
    fs::create_dir_all(audio_root(app)?)
        .map_err(|e| format!("Failed to create audio directory: {e}"))?;
    Ok(())
}

fn config_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve config directory: {e}"))
}

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve data directory: {e}"))
}

fn audio_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("audio"))
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("radiant_pipsqueak.db"))
}

fn api_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_root(app)?.join("openai_key.enc"))
}

fn hash_text(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn derive_title(content: &str) -> String {
    let one_line = content.lines().next().unwrap_or(content).trim();
    let compact = one_line.replace('\t', " ").replace("  ", " ");
    let mut chars = compact.chars();
    let title: String = chars.by_ref().take(56).collect();
    if compact.chars().count() > 56 {
        format!("{}...", title)
    } else {
        title
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn upsert_snippet(
    conn: &mut Connection,
    snippet_id: Option<i64>,
    title: &str,
    content: &str,
    content_hash: &str,
    now: &str,
) -> Result<i64, String> {
    if let Some(id) = snippet_id {
        conn.execute(
            "UPDATE snippets SET title = ?1, content = ?2, content_hash = ?3, updated_at = ?4 WHERE id = ?5",
            params![title, content, content_hash, now, id],
        )
        .map_err(|e| format!("Failed to update snippet: {e}"))?;
        return Ok(id);
    }

    conn.execute(
        "INSERT INTO snippets (title, content, content_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![title, content, content_hash, now],
    )
    .map_err(|e| format!("Failed to create snippet: {e}"))?;
    Ok(conn.last_insert_rowid())
}

// Finds existing audio for this exact paragraph/voice/model, active or not, so
// switching back to a previously used voice reuses its audio instead of paying
// for another generation.
fn find_paragraph_audio(
    conn: &Connection,
    snippet_id: i64,
    paragraph_hash: &str,
    voice: &str,
    model: &str,
) -> Result<Option<(i64, bool)>, String> {
    conn.query_row(
        "SELECT id, is_active FROM audio_records
         WHERE snippet_id = ?1
           AND paragraph_hash = ?2
           AND voice = ?3
           AND model = ?4
           AND status = 'generated'
         ORDER BY is_active DESC, updated_at DESC
         LIMIT 1",
        params![snippet_id, paragraph_hash, voice, model],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? == 1)),
    )
    .optional()
    .map_err(|e| format!("Failed to query existing paragraph audio: {e}"))
}

fn reactivate_paragraph_audio(
    conn: &mut Connection,
    snippet_id: i64,
    paragraph_hash: &str,
    voice: &str,
    model: &str,
    record_id: i64,
) -> Result<(), String> {
    let now = now_iso();
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to open database transaction: {e}"))?;
    tx.execute(
        "UPDATE audio_records SET is_active = 0
         WHERE snippet_id = ?1 AND paragraph_hash = ?2 AND voice = ?3 AND model = ?4",
        params![snippet_id, paragraph_hash, voice, model],
    )
    .map_err(|e| format!("Failed to deactivate paragraph audio variants: {e}"))?;
    tx.execute(
        "UPDATE audio_records SET is_active = 1, updated_at = ?1 WHERE id = ?2",
        params![now, record_id],
    )
    .map_err(|e| format!("Failed to reactivate paragraph audio: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit paragraph audio reactivation: {e}"))?;
    Ok(())
}

// Mirrors the frontend split: paragraphs are separated by blank
// (whitespace-only) lines, trimmed, with empty entries dropped.
fn split_paragraphs(text: &str) -> Vec<String> {
    let mut paragraphs = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            if !current.trim().is_empty() {
                paragraphs.push(current.trim().to_string());
            }
            current.clear();
        } else {
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(line);
        }
    }
    if !current.trim().is_empty() {
        paragraphs.push(current.trim().to_string());
    }
    paragraphs
}

fn get_snippet_summary(conn: &Connection, snippet_id: i64) -> Result<SnippetSummary, String> {
    let (id, title, content, content_hash, created_at, updated_at) = conn
        .query_row(
            "SELECT id, title, content, content_hash, created_at, updated_at FROM snippets WHERE id = ?1",
            params![snippet_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .map_err(|e| format!("Failed to query snippet summary: {e}"))?;

    let record_from_row = |row: &rusqlite::Row| -> rusqlite::Result<AudioRecordSummary> {
        Ok(AudioRecordSummary {
            id: row.get(0)?,
            voice: row.get(1)?,
            model: row.get(2)?,
            status: row.get(3)?,
            error: row.get(4)?,
            char_count: row.get(5)?,
            estimated_tokens: row.get(6)?,
            estimated_cost_usd: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            paragraph_text: row.get(10)?,
        })
    };

    const RECORD_COLUMNS: &str = "id, voice, model, status, error,
                    COALESCE(char_count, 0), COALESCE(estimated_tokens, 0), COALESCE(estimated_cost_usd, 0.0),
                    created_at, updated_at, paragraph_text";

    let active_audio = conn
        .query_row(
            &format!(
                "SELECT {RECORD_COLUMNS}
                 FROM audio_records
                 WHERE snippet_id = ?1 AND is_active = 1
                 ORDER BY updated_at DESC
                 LIMIT 1"
            ),
            params![snippet_id],
            record_from_row,
        )
        .optional()
        .map_err(|e| format!("Failed to query active audio: {e}"))?;

    let mut paragraph_audio = Vec::new();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {RECORD_COLUMNS}
             FROM audio_records
             WHERE snippet_id = ?1 AND is_active = 1 AND paragraph_hash IS NOT NULL
             ORDER BY updated_at DESC"
        ))
        .map_err(|e| format!("Failed to prepare paragraph audio query: {e}"))?;
    let rows = stmt
        .query_map(params![snippet_id], record_from_row)
        .map_err(|e| format!("Failed to query paragraph audio: {e}"))?;
    for row in rows {
        paragraph_audio.push(row.map_err(|e| format!("Failed to read paragraph audio row: {e}"))?);
    }

    let versions: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM audio_records WHERE snippet_id = ?1",
            params![snippet_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count snippet versions: {e}"))?;

    Ok(SnippetSummary {
        id,
        title,
        content,
        content_hash,
        created_at,
        updated_at,
        versions,
        active_audio,
        paragraph_audio,
    })
}

fn model_price_per_1m_chars(model: &str) -> f64 {
    match model {
        "gpt-4o-mini-tts" => 0.60,
        "tts-1" => 15.00,
        "tts-1-hd" => 30.00,
        _ => 15.00,
    }
}

fn compute_estimate(text: &str, model: &str) -> GenerationEstimate {
    let char_count = text.chars().count() as i64;
    let estimated_tokens = ((char_count as f64) / 4.0).ceil() as i64;
    let price_per_1m_chars_usd = model_price_per_1m_chars(model);
    let estimated_cost_usd = ((char_count as f64) / 1_000_000.0) * price_per_1m_chars_usd;
    // Rough narration pace: ~14 characters per spoken second.
    let estimated_duration_seconds = (char_count as f64) / 14.0;

    GenerationEstimate {
        char_count,
        estimated_tokens,
        estimated_cost_usd,
        price_per_1m_chars_usd,
        estimated_duration_seconds,
    }
}

fn save_audio_file(
    app: &AppHandle,
    snippet_id: i64,
    voice: &str,
    model: &str,
    content_hash: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let snippet_dir = audio_root(app)?.join(format!("snippet_{snippet_id}"));
    fs::create_dir_all(&snippet_dir)
        .map_err(|e| format!("Failed to create snippet audio folder: {e}"))?;

    let stamp = Utc::now().timestamp_millis();
    let hash_prefix: String = content_hash.chars().take(10).collect();
    let file_name = format!("{stamp}_{voice}_{model}_{hash_prefix}.mp3");
    let full_path = snippet_dir.join(file_name);
    fs::write(&full_path, bytes).map_err(|e| format!("Failed to write audio file: {e}"))?;

    let root = audio_root(app)?;
    relative_to(&full_path, &root)
}

fn relative_to(path: &Path, root: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|e| format!("Failed to build relative path: {e}"))
        .map(|p| p.to_string_lossy().to_string())
}

fn machine_fingerprint() -> String {
    let machine_id = fs::read_to_string("/etc/machine-id").unwrap_or_default();
    let user = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());
    format!("{}:{}:radiant-pipsqueak", machine_id.trim(), user)
}

fn encrypt_api_key(api_key: &str) -> Result<String, String> {
    let mut salt = [0_u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut nonce_bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);

    let key_bytes = derive_key(&salt);
    let cipher = Aes256GcmSiv::new_from_slice(&key_bytes)
        .map_err(|e| format!("Failed to initialize encryption: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, api_key.as_bytes())
        .map_err(|e| format!("Failed to encrypt API key: {e}"))?;

    let payload = EncryptedPayload {
        salt: B64.encode(salt),
        nonce: B64.encode(nonce_bytes),
        ciphertext: B64.encode(ciphertext),
    };

    serde_json::to_string(&payload).map_err(|e| format!("Failed to serialize key payload: {e}"))
}

fn decrypt_api_key(payload_json: &str) -> Result<String, String> {
    let payload: EncryptedPayload =
        serde_json::from_str(payload_json).map_err(|e| format!("Corrupt key payload: {e}"))?;
    let salt = B64
        .decode(payload.salt)
        .map_err(|e| format!("Invalid key payload salt: {e}"))?;
    let nonce_bytes = B64
        .decode(payload.nonce)
        .map_err(|e| format!("Invalid key payload nonce: {e}"))?;
    let ciphertext = B64
        .decode(payload.ciphertext)
        .map_err(|e| format!("Invalid key payload ciphertext: {e}"))?;

    let key_bytes = derive_key(&salt);
    let cipher = Aes256GcmSiv::new_from_slice(&key_bytes)
        .map_err(|e| format!("Failed to initialize decryptor: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| format!("Failed to decrypt API key: {e}"))?;

    String::from_utf8(plaintext).map_err(|e| format!("Invalid decrypted API key: {e}"))
}

fn derive_key(salt: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(machine_fingerprint().as_bytes());
    hasher.update(salt);
    let digest = hasher.finalize();
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest[..32]);
    out
}

fn read_api_key(app: &AppHandle) -> Result<String, String> {
    let key_path = api_key_path(app)?;
    let payload = fs::read_to_string(&key_path)
        .map_err(|e| format!("API key not configured or unreadable: {e}"))?;
    decrypt_api_key(&payload)
}

async fn call_openai_tts(
    api_key: &str,
    input: &str,
    voice: &str,
    model: &str,
    reading_instructions: Option<&str>,
) -> Result<Vec<u8>, String> {
    let client = Client::new();
    let mut body = serde_json::json!({
        "model": model,
        "voice": voice,
        "input": input,
        "response_format": "mp3"
    });

    if let Some(instructions) = reading_instructions {
        if !instructions.trim().is_empty() {
            body["instructions"] = serde_json::Value::String(instructions.trim().to_string());
        }
    }

    let response = client
        .post("https://api.openai.com/v1/audio/speech")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {e}"))?;

    if !response.status().is_success() {
        let code = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to parse OpenAI error response".to_string());
        return Err(format!("OpenAI request failed ({code}): {body}"));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read OpenAI audio bytes: {e}"))?;
    Ok(bytes.to_vec())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_setup_status,
            estimate_generation,
            get_usage_summary,
            get_usage_settings,
            save_usage_settings,
            get_usage_timeline,
            get_usage_limit_status,
            save_api_key,
            clear_api_key,
            list_snippets,
            generate_paragraph_audio,
            generate_voice_preview,
            get_audio_data_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
