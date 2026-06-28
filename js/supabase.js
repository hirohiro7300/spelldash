import { createClient } from "https://esm.sh/@supabase/supabase-js";

const supabaseUrl = "https://sujvgwozsnzjsjmkcrnk.supabase.co";

const supabaseKey = "ここに sb_publishable_... を貼る";

export const supabase = createClient(
  supabaseUrl,
  supabaseKey
);