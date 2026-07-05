import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Supabase の公開設定。ここに置くキーはブラウザに埋め込む前提の「公開キー」
// （anon / publishable キー）です。秘密の service_role キーは絶対に置かないこと。
// 取得場所：Supabase ダッシュボード → Project Settings → API → Project API keys
const supabaseUrl = "https://sujvgwozsnzjsjmkcrnk.supabase.co";
const supabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1anZnd296c256anNqbWtjcm5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MDA5NDIsImV4cCI6MjA5ODE3Njk0Mn0.NkgB0vIgI4Q3DL5fSuF4kbtF3P4ORMbHzoPGbnOG3mc";

// 有効なキーが設定されているか（未設定なら分かりやすいメッセージを出すため）
export const isSupabaseConfigured =
  supabaseAnonKey.length > 20 &&
  (supabaseAnonKey.startsWith("eyJ") || supabaseAnonKey.startsWith("sb_"));

if (!isSupabaseConfigured) {
  console.warn(
    "Supabase のキーが未設定です。js/supabase.js の supabaseAnonKey に " +
      "anon / publishable キーを貼り付けてください。"
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
