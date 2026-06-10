import { Polar } from "@polar-sh/sdk";

import { config } from "../config";

export const polarClient = new Polar({
  accessToken: config.polarAccessToken,
  server: config.polarEnvironment
});
