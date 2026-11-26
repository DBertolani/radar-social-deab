import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type InstagramMedia = {
  id: string;
  caption?: string;
  like_count?: number;
  comments_count?: number;
  media_type?: string;
  timestamp?: string;
  permalink?: string;
};

type DiscoveryProfile = {
  id: string;
  username: string;
  name?: string;
  biography?: string;
  followers_count?: number;
  media_count?: number;
  media?: { data?: InstagramMedia[] };
};

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function engagementRate(post: InstagramMedia, followers: number): number {
  if (followers <= 0) return 0;
  return ((numberOrZero(post.like_count) + numberOrZero(post.comments_count)) / followers) * 100;
}

function publicMetaError(error: any): { message: string; hint: string } {
  const code = Number(error?.code);
  const subcode = Number(error?.error_subcode);
  if (code === 190) return {
    message: "O token da Meta é inválido ou expirou.",
    hint: "Gere/renove META_ACCESS_TOKEN e atualize o secret da Edge Function.",
  };
  if (code === 10 || code === 200) return {
    message: "A Meta negou a permissão para consultar este perfil.",
    hint: "Confira as permissões do app, o acesso à Instagram Graph API e se a conta é elegível para Business Discovery.",
  };
  if (code === 100 || subcode === 33) return {
    message: "Perfil não encontrado ou não elegível para Business Discovery.",
    hint: "Confirme o @username. A API só permite consultar contas profissionais públicas (Business ou Creator); contas privadas e perfis pessoais não são compatíveis.",
  };
  return {
    message: String(error?.message || "A Graph API retornou um erro inesperado."),
    hint: "Confira os logs da Edge Function e as configurações do aplicativo Meta.",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido. Use POST." }, 405);

  try {
    let body: { username?: unknown; category?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Corpo inválido. Envie um JSON com username e category." }, 400);
    }

    const cleanUsername = String(body.username ?? "").trim().replace(/^@+/, "").toLowerCase();
    const allowedCategories = ["cliente", "proprio", "concorrente"];
    const category = String(body.category ?? "cliente").trim().toLowerCase();

    if (!cleanUsername || !/^[a-zA-Z0-9._]{1,30}$/.test(cleanUsername)) {
      return jsonResponse({ error: "Informe um @username válido do Instagram." }, 400);
    }
    if (!allowedCategories.includes(category)) {
      return jsonResponse({ error: "Categoria inválida.", allowed_categories: allowedCategories }, 400);
    }

    const metaAccessToken = Deno.env.get("META_ACCESS_TOKEN");
    const metaIgUserId = Deno.env.get("META_IG_USER_ID");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const missing = [
      ["META_ACCESS_TOKEN", metaAccessToken],
      ["META_IG_USER_ID", metaIgUserId],
      ["SUPABASE_URL", supabaseUrl],
      ["SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey],
    ].filter(([, value]) => !value).map(([key]) => key);

    if (missing.length) {
      return jsonResponse({ error: "Configuração incompleta na Edge Function.", missing_secrets: missing }, 500);
    }

    const fields = "business_discovery.username(" + cleanUsername + "){id,username,name,biography,followers_count,media_count,media.limit(20){id,caption,like_count,comments_count,media_type,timestamp,permalink}}";
    const graphUrl = new URL("https://graph.facebook.com/v27.0/" + metaIgUserId);
    graphUrl.searchParams.set("fields", fields);
    graphUrl.searchParams.set("access_token", metaAccessToken!);

    const metaResponse = await fetch(graphUrl.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const metaPayload = await metaResponse.json();

    if (!metaResponse.ok || metaPayload.error) {
      const mapped = publicMetaError(metaPayload.error);
      return jsonResponse({
        error: mapped.message,
        hint: mapped.hint,
        meta_error_code: metaPayload.error?.code ?? null,
        meta_error_subcode: metaPayload.error?.error_subcode ?? null,
      }, metaResponse.status >= 400 && metaResponse.status < 600 ? metaResponse.status : 502);
    }

    const profile: DiscoveryProfile | undefined = metaPayload.business_discovery;
    if (!profile?.id || !profile.username) {
      return jsonResponse({
        error: "A Meta não retornou dados para este perfil.",
        hint: "Verifique se o username pertence a uma conta profissional pública (Business ou Creator).",
      }, 404);
    }

    const posts = Array.isArray(profile.media?.data) ? profile.media!.data! : [];
    const followers = numberOrZero(profile.followers_count);
    const likesTotal = posts.reduce((sum, post) => sum + numberOrZero(post.like_count), 0);
    const commentsTotal = posts.reduce((sum, post) => sum + numberOrZero(post.comments_count), 0);
    const avgLikes = posts.length ? likesTotal / posts.length : 0;
    const avgComments = posts.length ? commentsTotal / posts.length : 0;
    const avgEngagement = posts.length && followers > 0
      ? ((likesTotal + commentsTotal) / posts.length / followers) * 100
      : 0;

    const postsWithMetrics = posts.map((post) => ({
      ...post,
      like_count: numberOrZero(post.like_count),
      comments_count: numberOrZero(post.comments_count),
      engagement_rate: engagementRate(post, followers),
    }));
    const rankedPosts = [...postsWithMetrics].sort((a, b) => b.engagement_rate - a.engagement_rate);
    const topPosts = rankedPosts.slice(0, 3);
    const worstPosts = [...rankedPosts].reverse().slice(0, 3);

    const supabase = createClient(supabaseUrl!, serviceRoleKey!, {
      db: { schema: "social_analytics" },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: savedProfile, error: profileError } = await supabase
      .from("monitored_profiles")
      .upsert({
        username: profile.username.toLowerCase(),
        ig_business_id: profile.id,
        full_name: profile.name ?? null,
        category,
      }, { onConflict: "username" })
      .select("id")
      .single();

    if (profileError || !savedProfile?.id) {
      console.error("Erro ao salvar monitored_profiles:", profileError);
      return jsonResponse({
        error: "Não foi possível salvar o perfil no banco de dados.",
        detail: profileError?.message ?? "ID do perfil não retornado.",
      }, 500);
    }

    const { error: snapshotError } = await supabase.from("profile_snapshots").insert({
      profile_id: savedProfile.id,
      biography: profile.biography ?? null,
      followers_count: followers,
      media_count: numberOrZero(profile.media_count),
      avg_engagement_rate: avgEngagement,
    });

    if (snapshotError) {
      console.error("Erro ao salvar profile_snapshots:", snapshotError);
      return jsonResponse({
        error: "Perfil coletado, mas não foi possível salvar o snapshot.",
        detail: snapshotError.message,
      }, 500);
    }

    if (postsWithMetrics.length) {
      const rows = postsWithMetrics.map((post) => ({
        ig_media_id: post.id,
        profile_id: savedProfile.id,
        caption: post.caption ?? null,
        like_count: post.like_count,
        comments_count: post.comments_count,
        media_type: post.media_type ?? null,
        timestamp: post.timestamp ?? null,
        permalink: post.permalink ?? null,
      }));
      const { error: postsError } = await supabase.from("posts_metrics")
        .upsert(rows, { onConflict: "ig_media_id" });

      if (postsError) {
        console.error("Erro ao salvar posts_metrics:", postsError);
        return jsonResponse({
          error: "Perfil coletado, mas não foi possível salvar as métricas dos posts.",
          detail: postsError.message,
        }, 500);
      }
    }

    return jsonResponse({
      profile: {
        id: profile.id,
        username: profile.username,
        name: profile.name ?? null,
        biography: profile.biography ?? "",
        followers_count: followers,
        media_count: numberOrZero(profile.media_count),
        category,
      },
      metrics_summary: {
        posts_sampled: posts.length,
        average_likes: avgLikes,
        average_comments: avgComments,
        avg_engagement_rate: avgEngagement,
        top_posts: topPosts,
        worst_posts: worstPosts,
      },
      posts: postsWithMetrics,
    });
  } catch (error) {
    console.error("Erro inesperado em coletar-instagram:", error);
    return jsonResponse({
      error: "Erro interno ao coletar o perfil do Instagram.",
      detail: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
