"use strict";

const fs = require("fs");
const path = require("path");

const PROJECTS = {
  "deab-homologacao": {
    SUPABASE_URL: "https://ywybqrunxreaencndztg.supabase.co",
    SUPABASE_ANON_KEY: "sb_publishable_3MB32qjyJD1IMrUHC9KEzA_t2e5L-tP"
  },
  "Sistemas-Dev": {
    SUPABASE_URL: "https://bvavzgmsiflydrlgeiqf.supabase.co",
    SUPABASE_ANON_KEY: "sb_publishable_IgTCeiytetM678AtADKUtQ_n3SL6akf"
  }
};

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método não permitido." });
  }

  try {
    const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config.json"), "utf8"));
    const project = PROJECTS[config.projeto_supabase];
    const supabaseUrl = config.SUPABASE_URL || config.supabase_url || (project && project.SUPABASE_URL);
    const anonKey = config.SUPABASE_ANON_KEY || config.supabase_anon_key || (project && project.SUPABASE_ANON_KEY);
    if (!supabaseUrl || !anonKey) throw new Error("Configuração pública do Supabase não identificada.");

    const endpoint = new URL("/rest/v1/bio_pages", supabaseUrl);
    endpoint.search = new URLSearchParams({
      select: "slug,username,display_name,updated_at",
      active: "eq.true",
      order: "updated_at.desc",
      limit: "20"
    }).toString();

    const response = await fetch(endpoint.toString(), {
      headers: {
        apikey: anonKey,
        Authorization: "Bearer " + anonKey,
        "Accept-Profile": "social_analytics"
      },
      signal: AbortSignal.timeout(12000)
    });

    const raw = await response.text();
    let rows = [];
    try { rows = raw ? JSON.parse(raw) : []; } catch { throw new Error("Resposta inválida do Supabase."); }
    if (!response.ok) {
      const detail = rows && (rows.message || rows.details || rows.hint);
      console.error("Supabase bio_pages list:", response.status, raw.slice(0, 500));
      return res.status(502).json({ error: detail || "Supabase respondeu HTTP " + response.status + "." });
    }
    if (!Array.isArray(rows)) throw new Error("Formato inesperado ao listar cartões.");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json(rows);
  } catch (error) {
    console.error("Falha ao listar cartões digitais:", error);
    return res.status(500).json({
      error: error && error.name === "TimeoutError"
        ? "O Supabase demorou para responder. Tente novamente."
        : (error.message || "Não foi possível listar cartões digitais.")
    });
  }
};
