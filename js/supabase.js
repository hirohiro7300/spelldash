import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = "https://sujvgwozsnzjsjmkcrnk.supabase.co";

const supabaseKey = "sb_publishable_から始まるキーをここに貼る";

export const supabase = createClient(supabaseUrl, supabaseKey);