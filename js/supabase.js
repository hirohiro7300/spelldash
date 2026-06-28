import { createClient } from "https://esm.sh/@supabase/supabase-js@2/";

const supabaseUrl = "https://sujvgwozsnzjsjmkcrnk.supabase.co";

const supabaseKey = "v";

// キーに日本語・全角文字・変な記号が混ざってないか確認
for (const char of supabaseKey) {
  if (char.charCodeAt(0) > 255) {
    throw new Error("Supabase keyに使えない文字が混ざっています。キーをコピーし直してください。");
  }
}

export const supabase = createClient(supabaseUrl, supabaseKey);