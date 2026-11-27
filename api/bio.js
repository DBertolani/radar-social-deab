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

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Método não permitido.");
  }

  const slugValue = Array.isArray(req.query.u) ? req.query.u[0] : req.query.u;
  const slug = String(slugValue || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(slug) || slug.length < 2) {
    return res.status(400).send("Slug inválido.");
  }

  try {
    const root = process.cwd();
    const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    // config.json é mantido intacto por ambiente. Se receber as chaves explicitamente,
    // elas têm prioridade; caso contrário, o identificador do projeto seleciona a chave pública.
    const project = PROJECTS[config.projeto_supabase];
    const supabaseUrl = config.SUPABASE_URL || config.supabase_url || (project && project.SUPABASE_URL);
    const anonKey = config.SUPABASE_ANON_KEY || config.supabase_anon_key || (project && project.SUPABASE_ANON_KEY);
    if (!supabaseUrl || !anonKey) throw new Error("Configuração pública do Supabase não identificada.");

    const endpoint = new URL("/rest/v1/bio_pages", supabaseUrl);
    endpoint.search = new URLSearchParams({
      select: "slug,username,display_name,tagline,avatar_url,theme_preset,accent_color,buttons,libras_video_url,active",
      slug: "eq." + slug,
      active: "eq.true",
      limit: "1"
    }).toString();

    const response = await fetch(endpoint.toString(), {
      headers: {
        apikey: anonKey,
        Authorization: "Bearer " + anonKey,
        "Accept-Profile": "social_analytics"
      }
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error("Supabase bio_pages:", response.status, detail.slice(0, 500));
      return res.status(502).send("Não foi possível consultar este cartão digital.");
    }

    const rows = await response.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(404).send("Cartão não encontrado ou inativo.");
    const row = rows[0] || {};\n    const data = { slug: row.slug || slug, username: row.username || "", display_name: row.display_name || "", tagline: row.tagline || "", avatar_url: row.avatar_url || "", theme_preset: row.theme_preset || "essencial", accent_color: row.accent_color || "#8b5cf6", buttons: Array.isArray(row.buttons) ? row.buttons.filter(Boolean) : [], libras_video_url: row.libras_video_url || "", active: row.active === true };
    const template = fs.readFileSync(path.join(process.cwd(), 'bio.html'), 'utf8');
    const title = escapeHtml(data.display_name || (data.username ? "@" + data.username : "Cartão Digital"));
    const description = escapeHtml(data.tagline || "Conheça os canais de contato de " + title + ".");
    const image = /^https?:\/\//i.test(data.avatar_url || "") ? escapeHtml(data.avatar_url) : "";
    const publicUrl = "https://bio.deab.com.br/" + encodeURIComponent(slug);
    const meta = [
      '<meta property="og:type" content="profile">',
      '<meta property="og:title" content="' + title + '">',
      '<meta property="og:description" content="' + description + '">',
      image ? '<meta property="og:image" content="' + image + '">' : "",
      '<meta property="og:url" content="' + escapeHtml(publicUrl) + '">',
      '<meta name="twitter:card" content="' + (image ? "summary_large_image" : "summary") + '">',
      '<meta name="twitter:title" content="' + title + '">',
      '<meta name="twitter:description" content="' + description + '">'
    ].filter(Boolean).join("\n");

    let html = template.replace("</head>", meta + "\n</head>");
    html = html.replace(/<title>[^<]*<\/title>/i, "<title>" + title + " | DEAB</title>");
    html = html.replace("<script>\n(function(){", "<script>window.__BIO_DATA__=" + jsonForHtml(data) + ";\n(function(){");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).send(html);
  } catch (error) {
    console.error("Falha ao renderizar cartão:", error);
    return res.status(500).send("Erro ao carregar o cartão digital.");
  }
};
