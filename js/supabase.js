import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// あなたのSupabaseプロジェクトURL
const supabaseUrl = "https://sujvgwozsnzjsjmkcrnk.supabase.co";

// ↓↓↓ Settings → API Keys → Publishable key を丸ごと貼る
const supabaseKey = "sb_publishable_UkRZid_8IhEX36Yg4U2sjg_n-gTsjC9";

export const supabase = createClient(supabaseUrl, supabaseKey);