import type { AuthProvider } from "../types";
import type { AuthInfo } from "../../types";

export class LocalAuthProvider implements AuthProvider {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.GREPTURE_API_KEY;
  }

  async authenticate(apiKey: string): Promise<AuthInfo | null> {
    // If GREPTURE_API_KEY is set, validate against it; otherwise accept any key
    if (this.apiKey && apiKey !== this.apiKey) return null;

    return {
      team_id: "local",
      user_id: "local",
      fallback_mode: "error",
      zero_data_mode: false,
      tier: "free",
    };
  }
}
