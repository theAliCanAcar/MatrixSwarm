# Matrix Swarm

Matrix Swarm runs several coding agents against the same Git checkpoint, evaluates their changes independently, and promotes the strongest eligible patch to a managed workspace.

## Start locally

Install Node.js 22.19 or later and Git. Start Docker if you want to use local isolation.

```sh
npm ci
npm start
```

Open [Matrix Swarm](http://127.0.0.1:4317). Set `PORT` to change the port. The server listens on loopback and stores runs, patches, logs, and settings in `.matrix/` by default. Use `MATRIX_DATA_DIR` to change the location. Settings keys are stored in a local file with owner-only permissions and are never returned to the browser. Environment variables can supply the keys instead.

## Run a swarm

Open **Repositories** and choose **Run demo** for Invoice API, Redirect Gateway, or Webhook Verifier. Each sample starts from its registered Git ref, selects Archil when configured, and enables Keenable research for the public sample task. Review both options before launch. The models generate council recommendations and candidate patches in isolated sandboxes. The evaluator runs functional and security checks on each patch before selecting an eligible winner. **Reset** returns future custom runs to the registered Git ref.

1. Open **Settings** and configure Fireworks AI, or set `FIREWORKS_API_KEY`. The default teams use Kimi K3.1 Pro, GLM-5.3, and DeepSeek V4.1 Flash. You can override models and hints under **Advanced options**.
2. Add a local Git working tree or an HTTPS Git URL. Choose a branch, tag, or commit if you want to start from a specific ref. Matrix Swarm takes committed files from that ref.
3. Choose the repository in **New run**, describe the task, and supply functional and security test commands. Both commands should exit zero on success. Add protected paths for test or benchmark files with project-specific names. An optional benchmark must print one nonnegative number. Lower benchmark scores rank first, followed by lower model token usage and smaller patches.
4. Choose an available isolated runtime and launch the run. The result shows each branch's checks and patch. **Logs** shows recorded commands and output across runs.
5. Review the winner and choose **Promote** or **Deploy to Archil**. Promotion creates a managed Git workspace. Subsequent runs for that repository start from the most recent promoted workspace.

### Chat and checkpoint tests

Open **Chat**, select a repository, and enter a request such as “Test this repository.” Review and edit the proposed commands before starting the checks. A checkpoint test uses the promoted workspace or registered Git ref and records the actual test output in the run. Chat can also summarize recorded results and draft a coding run.

### Deploy to Archil

Set an existing **Base sandbox ID** in Settings. From a verified run, choose **Deploy to Archil** to activate its release under `/opt/matrix-deployment/current/project`. Supply a start command to run it as the managed service, and a local port to check a listening server. When you redeploy the same repository, you can reuse its previous start command. A failed startup restores the previous release. Access to the service stays inside the sandbox unless you configure ingress separately.

Local runs use Docker. The sandbox cannot access the host's credentials or workspace and has no network egress by default. If your checks need external dependencies, prepare them in an image selected through `MATRIX_SANDBOX_IMAGE` or use a repository that contains the necessary inputs. Protect any files that define how your tests are discovered and run. The evaluator assumes the commands you supply are trusted.

## Provider usage

- **Fireworks AI** provides the default coding models and chat. **Usage** charts cumulative API requests and input/output tokens and shows active model cooldowns, rate limits, overload responses, and retries. Matrix honors `Retry-After` and retries rate-limited or overloaded requests within their original deadline. Existing Anthropic keys remain supported as a coding fallback when Fireworks is unconfigured.
- **Archil** offers persistent isolated sandboxes and an account metering window. Use an Archil API key with the relevant sandbox and billing permissions. The runtime needs an Archil plan that supports custom network rules. Configure the key and optional AWS region in Settings or set `ARCHIL_API_KEY` and `ARCHIL_REGION`. Set **Base sandbox ID** or `ARCHIL_BASE_SANDBOX_ID` to use an existing sandbox as the run template. Choose a sandbox without attached disks or exposed ports. Matrix Swarm checks out the repository and starts the agents in disposable forks. Select Archil when launching a run. Use the usage refresh to retrieve the current account window.

  To rotate runs across multiple templates, enter comma-separated IDs in **Additional run sandbox IDs** or set `ARCHIL_ADDITIONAL_SANDBOX_IDS`. All templates must be in the configured region and have no attached disks or exposed ports. Each run uses one template and creates separate disposable forks for its agents and checks. The **Base sandbox ID** also remains the target for **Deploy to Archil**.
- **Keenable** adds search excerpts to the agents' context before they start. For custom runs, opt in with **Gather research with Keenable**. The public endpoint can be used without a key. Configure a key in Settings or set `KEENABLE_API_KEY` to use authenticated search.
- **Casco** uses the public CVE API. Choose **Check locked npm dependencies with Casco** when launching a custom swarm or checkpoint test with a root npm lockfile (version 2 or 3). Matrix Swarm sends exact public package names and versions and records a pass or failure with the other checks. Incomplete inventories and reported vulnerabilities fail the gate. The built-in samples use Node.js built-ins and have no npm lockfile.

The **Usage** tab shows successful and failed requests and measured values such as tokens, credits, and package checks when the provider returns them. Archil's account window is displayed independently of local request totals.
