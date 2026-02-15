import { app } from "./app";
import { assertRequiredConfig, config } from "./config";

assertRequiredConfig();

app.listen(config.port, () => {
  console.info(`API listening on http://localhost:${config.port}`);
});
