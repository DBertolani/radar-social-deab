import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Media = {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  view_count?: number;
  children?: { data?: Array<{ media_url?: string; media_type?: string }> };
};
type Profile = {
  id: string;
  username: string;
  name?: string;
  biography?: string;
  website?: string;
  profile_picture_url?: string;
  followers_count?: number;
  media_count?: number;
  media?: { data?: Media[] };
};

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const rate = (post: Media, followers: number) =>
  followers > 0 ? ((num(post.like_count) + num(post.comments_count)) / followers) * 100 : 0;

function metaError(error: any) {
  const code = Number(error?.code);
  if (code === 190) return { error: "O token da Meta é inválido ou expirou.", hint: "Renove META_ACCESS_TOKEN nos secrets da Edge Function." };
  if (code === 10 || code === 200) return { error: "A Meta negou a permissão para consultar este perfil.", hint: "Confira permissões do app e elegibilidade para Business Discovery." };
  if (code === 100 || Number(error?.error_subcode) === 33) return { error: "Perfil não encontrado ou não elegível para Business Discovery.", hint: "Confirme o @username. A consulta exige conta profissional pública (Business ou Creator); perfis pessoais e privados não são compatíveis." };
  return { error: String(error?.message || "Erro inesperado da Graph API."), hint: "Confira os logs da Edge Function e as permissões do aplicativo Meta." };
}
function normalizeUsername(value: unknown): string {
  return String(value ?? "").trim().replace(/^@+/, "").toLowerCase();
}
function shapeProfile(p: Profile, category?: string) {
  const posts = Array.isArray(p.media?.data) ? p.media!.data! : [];
  const followers = num(p.followers_count);
  const enriched = posts.map(post => ({
    ...post,
    like_count: num(post.like_count),
    comments_count: num(post.comments_count),
    view_count: post.view_count == null ? null : num(post.view_count),
    engagement_rate: rate(post, followers),
    media_url: post.media_url || null,
    children: post.children?.data || [],
  }));
  const sorted = [...enriched].sort((a, b) => b.engagement_rate - a.engagement_rate);
  const likes = enriched.reduce((s, p) => s + p.like_count, 0);
  const comments = enriched.reduce((s, p) => s + p.comments_count, 0);
  return {
    profile: {
      id: p.id, username: p.username, name: p.name ?? null,
      biography: p.biography ?? "", website: p.website ?? "",
      profile_picture_url: p.profile_picture_url ?? null,
      followers_count: followers, media_count: num(p.media_count), ...(category ? { category } : {}),
    },
    posts: enriched,
    metrics_summary: {
      posts_sampled: enriched.length,
      average_likes: enriched.length ? likes / enriched.length : 0,
      average_comments: enriched.length ? comments / enriched.length : 0,
      avg_engagement_rate: enriched.length && followers ? ((likes + comments) / enriched.length / followers) * 100 : 0,
      top_posts: sorted.slice(0, 3),
      worst_posts: [...sorted].reverse().slice(0, 3),
    },
  };
}

async function fetchDiscovery(username: string, igUserId: string, token: string): Promise<Profile> {
  // media_url é opcional na resposta. thumbnail_url não é solicitado para evitar erro #100.
  const mediaFields = "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count,view_count,children{media_url,media_type}";
  const discovery = "business_discovery.username(" + username + "){id,username,name,biography,website,profile_picture_url,followers_count,media_count,media.limit(20){" + mediaFields + "}}";
  const url = new URL("https://graph.facebook.com/v27.0/" + igUserId);
  url.searchParams.set("fields", discovery);
  url.searchParams.set("access_token", token);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const mapped = metaError(payload.error || {});
    throw Object.assign(new Error(mapped.error), {
      status: response.status >= 400 && response.status < 600 ? response.status : 502,
      hint: mapped.hint, metaCode: payload.error?.code ?? null,
      metaSubcode: payload.error?.error_subcode ?? null, username,
    });
  }
  if (!payload.business_discovery?.id || !payload.business_discovery?.username) {
    throw Object.assign(new Error("A Meta não retornou dados para @" + username + "."),
      { status: 404, hint: "Business Discovery aceita contas profissionais públicas (Business ou Creator)." });
  }
  return payload.business_discovery as Profile;
}

const geminiSchema = {
  type: "OBJECT",
  properties: {
    auditoria_bio: {
      type: "OBJECT",
      properties: {
        pontos_fortes: { type: "ARRAY", items: { type: "STRING" } },
        melhorias: { type: "ARRAY", items: { type: "STRING" } },
        sugestoes_bio: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["pontos_fortes", "melhorias", "sugestoes_bio"],
    },
    comparativo_nicho: { type: "ARRAY", items: { type: "OBJECT", properties: {
      username: { type: "STRING" }, pontos_fortes: { type: "ARRAY", items: { type: "STRING" } },
      oportunidades: { type: "ARRAY", items: { type: "STRING" } }, diferencas_observadas: { type: "ARRAY", items: { type: "STRING" } },
    }, required: ["username", "pontos_fortes", "oportunidades", "diferencas_observadas"] } },
    analise_visual_conteudo: { type: "OBJECT", properties: {
      padroes_visuais: { type: "ARRAY", items: { type: "STRING" } },
      formatos_e_temas: { type: "ARRAY", items: { type: "STRING" } },
      oportunidades: { type: "ARRAY", items: { type: "STRING" } },
      observacoes_imagens: { type: "ARRAY", items: { type: "STRING" } },
    }, required: ["padroes_visuais", "formatos_e_temas", "oportunidades", "observacoes_imagens"] },
    ideias_posts_reels: { type: "ARRAY", items: { type: "OBJECT", properties: {
      formato: { type: "STRING" }, tema: { type: "STRING" }, gancho: { type: "STRING" },
      roteiro: { type: "ARRAY", items: { type: "STRING" } }, cta: { type: "STRING" }, objetivo: { type: "STRING" },
    }, required: ["formato", "tema", "gancho", "roteiro", "cta", "objetivo"] } },
  },
  required: ["auditoria_bio", "comparativo_nicho", "analise_visual_conteudo", "ideias_posts_reels"],
};

async function analyzeWithGemini(apiKey: string, primary: ReturnType<typeof shapeProfile>, competitors: Array<ReturnType<typeof shapeProfile>>, nicheContext: string) {
  const mediaHighlights = [
    ...primary.metrics_summary.top_posts.map((p: any) => ({ classificacao: "top", media_url: p.media_url, media_type: p.media_type, caption: p.caption })),
    ...primary.metrics_summary.worst_posts.map((p: any) => ({ classificacao: "menor_engajamento", media_url: p.media_url, media_type: p.media_type, caption: p.caption })),
  ];
  const prompt = `Você é estrategista sênior de Instagram. Faça uma análise fundamentada nos dados fornecidos. Contexto adicional: ${nicheContext || "Não informado"}.
Analise a bio e o link, compare o perfil principal aos concorrentes/referências, e avalie padrões visuais e conteúdo. As URLs de mídia são referências para identificação dos posts; não afirme ter visto imagens quando a URL estiver ausente ou não puder ser acessada. Não invente fatos nem métricas. Indique claramente quando houver amostra pequena ou dados indisponíveis. Sugira exatamente 2 versões de bio, respeitando limites práticos do Instagram. Gere ideias aplicáveis de posts e roteiros de Reels em português brasileiro.
Retorne somente JSON seguindo o schema solicitado.
DADOS:
${JSON.stringify({ perfil_principal: primary, concorrentes, imagens_top3_e_piores3: mediaHighlights }, null, 2)}`;
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: geminiSchema, temperature: 0.4 },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "Falha na API Gemini.");
  const text = payload.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("");
  if (!text) throw new Error("Gemini não retornou conteúdo estruturado.");
  return JSON.parse(text);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido. Use POST." }, 405);
  try {
    let body: { username?: unknown; category?: unknown; competitors?: unknown; niche_context?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "Envie um JSON válido." }, 400); }

    const username = normalizeUsername(body.username);
    const category = String(body.category ?? "cliente").trim().toLowerCase();
    const allowed = ["cliente", "proprio", "concorrente"];
    if (!/^[a-z0-9._]{1,30}$/.test(username)) return jsonResponse({ error: "Informe um @username principal válido." }, 400);
    if (!allowed.includes(category)) return jsonResponse({ error: "Categoria inválida.", allowed_categories: allowed }, 400);

    const competitorInput = Array.isArray(body.competitors)
      ? body.competitors : String(body.competitors ?? "").split(",");
    const competitors = [...new Set(competitorInput.map(normalizeUsername).filter((v: string) => v && v !== username))];
    if (competitors.length > 3) return jsonResponse({ error: "Informe no máximo 3 concorrentes/referências." }, 400);
    for (const name of competitors) if (!/^[a-z0-9._]{1,30}$/.test(name)) return jsonResponse({ error: "Username de concorrente inválido: @" + name }, 400);

    const metaToken = Deno.env.get("META_ACCESS_TOKEN");
    const igUserId = Deno.env.get("META_IG_USER_ID");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const missing = [["META_ACCESS_TOKEN", metaToken], ["META_IG_USER_ID", igUserId],
      ["SUPABASE_URL", supabaseUrl], ["SUPABASE_SERVICE_ROLE_KEY", serviceKey]]
      .filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) return jsonResponse({ error: "Configuração incompleta na Edge Function.", missing_secrets: missing }, 500);

    const primaryRaw = await fetchDiscovery(username, igUserId!, metaToken!);
    const primary = shapeProfile(primaryRaw, category);
    const competitorResults: Array<ReturnType<typeof shapeProfile> & { error?: string; hint?: string }> = [];
    for (const competitor of competitors) {
      try {
        competitorResults.push(shapeProfile(await fetchDiscovery(competitor, igUserId!, metaToken!)));
      } catch (error: any) {
        competitorResults.push({ profile: { id: "", username: competitor, name: null, biography: "", website: "", profile_picture_url: null, followers_count: 0, media_count: 0 }, posts: [], metrics_summary: { posts_sampled: 0, average_likes: 0, average_comments: 0, avg_engagement_rate: 0, top_posts: [], worst_posts: [] }, error: error.message, hint: error.hint });
      }
    }

    // Mantém a persistência existente somente para o perfil principal e schema social_analytics.
    const supabase = createClient(supabaseUrl!, serviceKey!, {
      db: { schema: "social_analytics" }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: saved, error: saveProfileError } = await supabase.from("monitored_profiles").upsert({
      username: primary.profile.username.toLowerCase(), ig_business_id: primary.profile.id,
      full_name: primary.profile.name, category,
    }, { onConflict: "username" }).select("id").single();
    if (saveProfileError || !saved?.id) {
      console.error("monitored_profiles:", saveProfileError);
      return jsonResponse({ error: "Não foi possível salvar o perfil principal.", detail: saveProfileError?.message }, 500);
    }
    const { error: snapshotError } = await supabase.from("profile_snapshots").insert({
      profile_id: saved.id, biography: primary.profile.biography || null,
      followers_count: primary.profile.followers_count, media_count: primary.profile.media_count,
      avg_engagement_rate: primary.metrics_summary.avg_engagement_rate,
    });
    if (snapshotError) return jsonResponse({ error: "Perfil coletado, mas o snapshot não foi salvo.", detail: snapshotError.message }, 500);

    if (primary.posts.length) {
      const rows = primary.posts.map((p: any) => ({
        ig_media_id: p.id, profile_id: saved.id, caption: p.caption ?? null,
        like_count: p.like_count, comments_count: p.comments_count, media_type: p.media_type ?? null,
        timestamp: p.timestamp ?? null, permalink: p.permalink ?? null,
      }));
      const { error } = await supabase.from("posts_metrics").upsert(rows, { onConflict: "ig_media_id" });
      if (error) return jsonResponse({ error: "Perfil coletado, mas as métricas dos posts não foram salvas.", detail: error.message }, 500);
    }

    let aiAnalysis: unknown = null;
    let aiWarning: string | null = null;
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (geminiKey) {
      try {
        aiAnalysis = await analyzeWithGemini(geminiKey, primary, competitorResults, String(body.niche_context ?? "").trim());
      } catch (error) {
        console.error("Gemini analysis failed:", error);
        aiWarning = error instanceof Error ? error.message : "Não foi possível concluir a análise Gemini.";
      }
    }

    return jsonResponse({
      profile: { ...primary.profile, id: saved.id },
      metrics_summary: primary.metrics_summary,
      posts: primary.posts,
      competitors: competitorResults,
      ai_analysis: aiAnalysis,
      ai_enabled: Boolean(geminiKey),
      ai_warning: aiWarning,
      niche_context: String(body.niche_context ?? "").trim(),
    });
  } catch (error: any) {
    console.error("coletar-instagram:", error);
    if (error?.username) return jsonResponse({
      error: error.message, hint: error.hint, username: error.username,
      meta_error_code: error.metaCode ?? null, meta_error_subcode: error.metaSubcode ?? null,
    }, error.status || 502);
    return jsonResponse({ error: "Erro interno ao analisar Instagram.", detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});
