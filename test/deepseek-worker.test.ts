import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDeepSeekWorkerArgs, runDeepSeekWorkerCommand } from "../src/runtime/deepseek-worker.js";

describe("DeepSeek direct worker", () => {
  it("parses model-command and run-task commands", () => {
    expect(parseDeepSeekWorkerArgs(["model-command", "--reasoning-effort", "max", "--max-tokens", "1234", "--sensitive-context-mode", "strict"])).toMatchObject({
      command: "model-command",
      reasoningEffort: "max",
      maxTokens: 1234,
      sensitiveContextMode: "strict"
    });
    expect(
      parseDeepSeekWorkerArgs([
        "run-task",
        "--task-packet",
        "packet.json",
        "--role",
        "reviewer",
        "--output",
        "out.json",
        "--patch-mode",
        "write",
        "--patch-file",
        "patches/out.patch"
      ])
    ).toMatchObject({
      command: "run-task",
      taskPacketPath: "packet.json",
      role: "reviewer",
      outputFile: "out.json",
      patchMode: "write",
      patchFile: "patches/out.patch"
    });
  });

  it("converts DeepSeek task_generation JSON into project queue tasks", async () => {
    const result = await runDeepSeekWorkerCommand(
      parseDeepSeekWorkerArgs(["model-command"]),
      {
        env: { DEEPSEEK_API_KEY: "test-key" },
        stdin: JSON.stringify({
          kind: "task_generation",
          modelAlias: "task.writer",
          route: { provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" },
          queue: { queueId: "queue_1" },
          input: { plan: "Build one task." }
        }),
        fetchImpl: async () =>
          fakeJsonResponse({
            id: "resp_1",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    phases: [{ name: "implementation" }],
                    tasks: [
                      {
                        title: "Implement adapter",
                        goal: "Add the DeepSeek direct adapter.",
                        risk: "medium",
                        expectedFiles: ["src/runtime/deepseek-worker.ts"],
                        acceptanceCriteria: ["Unit tests pass"]
                      }
                    ]
                  })
                }
              }
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 200 }
          })
      }
    );

    expect(result.tasks).toMatchObject([
      {
        clientKey: "deepseek-1",
        title: "Implement adapter",
        goal: "Add the DeepSeek direct adapter.",
        risk: "medium",
        expectedFiles: ["src/runtime/deepseek-worker.ts"],
        acceptanceCriteria: ["Unit tests pass"]
      }
    ]);
    expect(result._meta).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "max" });
  });

  it("allows sensitive-looking model-command stdin by default in Senior mode", async () => {
    let calls = 0;
    const result = await runDeepSeekWorkerCommand(parseDeepSeekWorkerArgs(["model-command"]), {
      env: { DEEPSEEK_API_KEY: "test-key", AGENT_FABRIC_SENIOR_MODE: "permissive" },
      stdin: JSON.stringify({
        kind: "prompt_improvement",
        route: { provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" },
        input: { prompt: "Review task-relevant config with api_key=abcdefghijklmnopqrstuvwxyzABCDEFGH" }
      }),
      fetchImpl: async () => {
        calls += 1;
        return fakeJsonResponse({
          id: "resp_model_command_senior",
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ improvedPrompt: "Senior prompt accepted.", summary: "ok" }) }
            }
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 }
        });
      }
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({ improvedPrompt: "Senior prompt accepted." });
  });

  it("honors explicit sensitive-context scanning for model-command in Senior mode", async () => {
    let calls = 0;
    await expect(
      runDeepSeekWorkerCommand(parseDeepSeekWorkerArgs(["model-command", "--sensitive-context-mode", "basic"]), {
        env: { DEEPSEEK_API_KEY: "test-key", AGENT_FABRIC_SENIOR_MODE: "permissive" },
        stdin: JSON.stringify({
          kind: "prompt_improvement",
          route: { provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" },
          input: { prompt: "Review task-relevant config with api_key=abcdefghijklmnopqrstuvwxyzABCDEFGH" }
        }),
        fetchImpl: async () => {
          calls += 1;
          return fakeJsonResponse({});
        }
      })
    ).rejects.toThrow("sensitive material");
    expect(calls).toBe(0);
  });

  it("writes a structured task report artifact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: { queueTaskId: "pqtask_1", fabricTaskId: "task_1", title: "Review", goal: "Review the patch." }
      }),
      "utf8"
    );

    const result = await runDeepSeekWorkerCommand(
      parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--role", "risk-reviewer", "--output", outputPath]),
      {
        cwd: dir,
        env: { DEEPSEEK_API_KEY: "test-key" },
        fetchImpl: async () =>
          fakeJsonResponse({
            id: "resp_2",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    status: "needs_review",
                    summary: "Risk review complete.",
                    risks: [{ severity: "medium", body: "Needs concurrency test." }],
                    testsSuggested: ["npm test -- project-cli"]
                  })
                }
              }
            ],
            usage: { prompt_tokens: 300, completion_tokens: 100 }
          })
      }
    );

    expect(result).toMatchObject({ role: "risk-reviewer", status: "needs_review", outputFile: outputPath, queueTaskId: "pqtask_1" });
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      schema: "agent-fabric.deepseek-worker-result.v1",
      role: "risk-reviewer",
      status: "needs_review",
      result: {
        summary: "Risk review complete.",
        testsSuggested: ["npm test -- project-cli"]
      }
    });
  });

  it("retries DeepSeek 429 rate limits before failing a lane", async () => {
    let calls = 0;
    const result = await runDeepSeekWorkerCommand(
      parseDeepSeekWorkerArgs(["model-command"]),
      {
        env: { DEEPSEEK_API_KEY: "test-key" },
        stdin: JSON.stringify({
          kind: "prompt_improvement",
          modelAlias: "prompt.improve.strong",
          route: { provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" },
          queue: { queueId: "queue_1" },
          input: { prompt: "Build a factory mode." }
        }),
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) return fakeJsonResponse({ error: { message: "slow down" } }, { ok: false, status: 429, retryAfter: "0" });
          return fakeJsonResponse({
            id: "resp_retry",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    improvedPrompt: "Use the full DeepSeek factory mode.",
                    summary: "Retried successfully."
                  })
                }
              }
            ],
            usage: { prompt_tokens: 500, completion_tokens: 100 }
          });
        }
      }
    );

    expect(calls).toBe(2);
    expect(result.improvedPrompt).toBe("Use the full DeepSeek factory mode.");
  });

  it("retries empty DeepSeek JSON content before marking the lane failed", async () => {
    let calls = 0;
    const result = await runDeepSeekWorkerCommand(
      parseDeepSeekWorkerArgs(["model-command"]),
      {
        env: { DEEPSEEK_API_KEY: "test-key" },
        stdin: JSON.stringify({
          kind: "prompt_improvement",
          modelAlias: "prompt.improve.strong",
          route: { provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" },
          queue: { queueId: "queue_1" },
          input: { prompt: "Build a factory mode." }
        }),
        fetchImpl: async () => {
          calls += 1;
          return fakeJsonResponse({
            id: `resp_empty_${calls}`,
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content:
                    calls === 1
                      ? ""
                      : JSON.stringify({
                          improvedPrompt: "Use the retry-safe DeepSeek factory mode.",
                          summary: "Empty content retried successfully."
                        })
                }
              }
            ],
            usage: { prompt_tokens: 500, completion_tokens: 100 }
          });
        }
      }
    );

    expect(calls).toBe(2);
    expect(result.improvedPrompt).toBe("Use the retry-safe DeepSeek factory mode.");
  });

  it("uses configurable DeepSeek pricing estimates when provided", async () => {
    const result = await runDeepSeekWorkerCommand(parseDeepSeekWorkerArgs(["model-command"]), {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        AGENT_FABRIC_DEEPSEEK_PRICING_JSON: JSON.stringify({
          "deepseek-v4-pro": { hit: 1, miss: 2, output: 3 }
        })
      },
      stdin: JSON.stringify({
        kind: "prompt_improvement",
        modelAlias: "prompt.improve.strong",
        route: { provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" },
        queue: { queueId: "queue_1" },
        input: { prompt: "Build a factory mode." }
      }),
      fetchImpl: async () =>
        fakeJsonResponse({
          id: "resp_pricing",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  improvedPrompt: "Use configurable pricing.",
                  summary: "Pricing override used."
                })
              }
            }
          ],
          usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60, completion_tokens: 10 }
        })
    });

    expect(result._meta).toMatchObject({
      costUsd: 0.00019,
      costEstimateSource: "env:AGENT_FABRIC_DEEPSEEK_PRICING_JSON"
    });
  });

  it("rejects task packets that appear to contain secrets before calling DeepSeek", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    let calls = 0;
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: {
          queueTaskId: "pqtask_sensitive",
          fabricTaskId: "task_sensitive",
          title: "Sensitive",
          goal: "Use api_key=abcdefghijklmnopqrstuvwxyzABCDEFGH"
        }
      }),
      "utf8"
    );

    await expect(
      runDeepSeekWorkerCommand(parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath]), {
        cwd: dir,
        env: { DEEPSEEK_API_KEY: "test-key" },
        fetchImpl: async () => {
          calls += 1;
          return fakeJsonResponse({});
        }
      })
    ).rejects.toThrow("sensitive material");
    expect(calls).toBe(0);
  });

  it("adds high-entropy detection in strict sensitive-context mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    let calls = 0;
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: {
          queueTaskId: "pqtask_entropy",
          fabricTaskId: "task_entropy",
          title: "Entropy",
          goal: "Review candidate value Z9qX7mN2pR5tV8wY3sD6fG1hJ4kL0bC9zQ2wE5rT8yU1iO4pA7 without sending secrets."
        }
      }),
      "utf8"
    );

    await expect(
      runDeepSeekWorkerCommand(parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath, "--sensitive-context-mode", "strict"]), {
        cwd: dir,
        env: { DEEPSEEK_API_KEY: "test-key" },
        fetchImpl: async () => {
          calls += 1;
          return fakeJsonResponse({});
        }
      })
    ).rejects.toThrow("high-entropy-token");
    expect(calls).toBe(0);
  });

  it("allows sensitive-looking packets only with an explicit override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: {
          queueTaskId: "pqtask_sensitive_override",
          fabricTaskId: "task_sensitive_override",
          title: "Sensitive override",
          goal: "Review a redaction test with api_key=abcdefghijklmnopqrstuvwxyzABCDEFGH"
        }
      }),
      "utf8"
    );

    const result = await runDeepSeekWorkerCommand(
      parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath, "--allow-sensitive-context"]),
      {
        cwd: dir,
        env: { DEEPSEEK_API_KEY: "test-key" },
        fetchImpl: async () =>
          fakeJsonResponse({
            id: "resp_sensitive_override",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    status: "needs_review",
                    summary: "Override accepted for explicit operator test."
                  })
                }
              }
            ],
            usage: { prompt_tokens: 300, completion_tokens: 100 }
          })
      }
    );

    expect(result).toMatchObject({ status: "needs_review", outputFile: outputPath });
  });

  it("allows sensitive-looking packets by default in Senior mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: {
          queueTaskId: "pqtask_senior_mode",
          fabricTaskId: "task_senior_mode",
          title: "Senior mode",
          goal: "Review a task-relevant local config sample with api_key=abcdefghijklmnopqrstuvwxyzABCDEFGH"
        }
      }),
      "utf8"
    );

    const result = await runDeepSeekWorkerCommand(parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath]), {
      cwd: dir,
      env: { DEEPSEEK_API_KEY: "test-key", AGENT_FABRIC_SENIOR_MODE: "permissive" },
      fetchImpl: async () =>
        fakeJsonResponse({
          id: "resp_senior_mode",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  status: "needs_review",
                  summary: "Senior mode default accepted."
                })
              }
            }
          ],
          usage: { prompt_tokens: 300, completion_tokens: 100 }
        })
    });

    expect(result).toMatchObject({ status: "needs_review", outputFile: outputPath });
  });

  it("honors explicit sensitive-context scanning in Senior mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    let calls = 0;
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: {
          queueTaskId: "pqtask_senior_strict",
          fabricTaskId: "task_senior_strict",
          title: "Senior strict",
          goal: "Run a sanitized review over api_key=abcdefghijklmnopqrstuvwxyzABCDEFGH"
        }
      }),
      "utf8"
    );

    await expect(
      runDeepSeekWorkerCommand(parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath, "--sensitive-context-mode", "basic"]), {
        cwd: dir,
        env: { DEEPSEEK_API_KEY: "test-key", AGENT_FABRIC_SENIOR_MODE: "permissive" },
        fetchImpl: async () => {
          calls += 1;
          return fakeJsonResponse({});
        }
      })
    ).rejects.toThrow("sensitive material");
    expect(calls).toBe(0);
  });

  it("requires queue backing for Senior TASK_DIR direct lanes before calling DeepSeek", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    let calls = 0;
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: {
          clientKey: "senior-lane-1",
          title: "Queue backed lane",
          goal: "Run as a visible queue-backed Senior lane."
        }
      }),
      "utf8"
    );

    await expect(
      runDeepSeekWorkerCommand(parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath]), {
        cwd: dir,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          AGENT_FABRIC_SENIOR_MODE: "permissive",
          TASK_DIR: dir,
          AGENT_FABRIC_SOCKET: join(dir, "missing.sock")
        },
        fetchImpl: async () => {
          calls += 1;
          return fakeJsonResponse({});
        }
      })
    ).rejects.toThrow("must be queue-backed");
    expect(calls).toBe(0);
  });

  it("allows explicit file-only Senior TASK_DIR runs when auto queueing is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    let calls = 0;
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: {
          clientKey: "senior-lane-file-only",
          title: "File only lane",
          goal: "Run without queue registration only when explicitly disabled."
        }
      }),
      "utf8"
    );

    const result = await runDeepSeekWorkerCommand(parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath]), {
      cwd: dir,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        AGENT_FABRIC_SENIOR_MODE: "permissive",
        TASK_DIR: dir,
        AGENT_FABRIC_DEEPSEEK_AUTO_QUEUE: "off"
      },
      fetchImpl: async () => {
        calls += 1;
        return fakeJsonResponse({
          id: "resp_senior_file_only",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  status: "needs_review",
                  summary: "Explicit file-only Senior run completed."
                })
              }
            }
          ],
          usage: { prompt_tokens: 300, completion_tokens: 100 }
        });
      }
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: "needs_review", outputFile: outputPath });
    expect(result.queueBacked).toBeUndefined();
  });

  it("writes proposed patches without applying them in patch-mode write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    const patchPath = join(dir, "result.patch");
    const targetPath = join(dir, "hello.txt");
    writeFileSync(targetPath, "old\n", "utf8");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: { queueTaskId: "pqtask_2", fabricTaskId: "task_2", title: "Patch", goal: "Patch one file." }
      }),
      "utf8"
    );
    const proposedPatch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");

    const result = await runDeepSeekWorkerCommand(
      parseDeepSeekWorkerArgs([
        "run-task",
        "--task-packet",
        packetPath,
        "--output",
        outputPath,
        "--patch-mode",
        "write",
        "--patch-file",
        patchPath
      ]),
      {
        cwd: dir,
        env: { DEEPSEEK_API_KEY: "test-key" },
        fetchImpl: async () =>
          fakeJsonResponse({
            id: "resp_3",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    status: "patch_ready",
                    summary: "Patch prepared.",
                    proposedPatch,
                    changedFilesSuggested: ["hello.txt"]
                  })
                }
              }
            ],
            usage: { prompt_tokens: 300, completion_tokens: 100 }
          })
      }
    );

    expect(result).toMatchObject({ status: "patch_ready", patchMode: "write", patchFile: patchPath });
    expect(readFileSync(patchPath, "utf8")).toContain("diff --git a/hello.txt b/hello.txt");
    expect(readFileSync(targetPath, "utf8")).toBe("old\n");
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      patchMode: "write",
      patchFile: patchPath,
      result: { proposedPatch }
    });
  });

  it("applies proposed patches only in explicit patch-mode apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    const patchPath = join(dir, "result.patch");
    const targetPath = join(dir, "hello.txt");
    writeFileSync(targetPath, "old\n", "utf8");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: { queueTaskId: "pqtask_3", fabricTaskId: "task_3", title: "Apply", goal: "Apply one file patch." }
      }),
      "utf8"
    );
    const proposedPatch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");

    const result = await runDeepSeekWorkerCommand(
      parseDeepSeekWorkerArgs([
        "run-task",
        "--task-packet",
        packetPath,
        "--output",
        outputPath,
        "--patch-mode",
        "apply",
        "--patch-file",
        patchPath
      ]),
      {
        cwd: dir,
        env: { DEEPSEEK_API_KEY: "test-key" },
        fetchImpl: async () =>
          fakeJsonResponse({
            id: "resp_4",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    status: "patch_ready",
                    summary: "Patch ready to apply.",
                    proposedPatch,
                    changedFilesSuggested: ["hello.txt"]
                  })
                }
              }
            ],
            usage: { prompt_tokens: 300, completion_tokens: 100 }
          })
      }
    );

    expect(result).toMatchObject({
      status: "patch_ready",
      patchMode: "apply",
      patchFile: patchPath,
      patchApply: { applied: true, exitCode: 0 }
    });
    expect(readFileSync(targetPath, "utf8")).toBe("new");
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      patchMode: "apply",
      patchFile: patchPath,
      patchApply: { applied: true, exitCode: 0 }
    });
  });

  it("rejects proposed patches with unsafe paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: { queueTaskId: "pqtask_4", fabricTaskId: "task_4", title: "Unsafe", goal: "Reject unsafe patch." }
      }),
      "utf8"
    );
    const proposedPatch = [
      "diff --git a/../evil.txt b/../evil.txt",
      "--- a/../evil.txt",
      "+++ b/../evil.txt",
      "@@ -0,0 +1 @@",
      "+owned"
    ].join("\n");

    await expect(
      runDeepSeekWorkerCommand(
        parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath, "--patch-mode", "write"]),
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: "test-key" },
          fetchImpl: async () =>
            fakeJsonResponse({
              id: "resp_5",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      status: "patch_ready",
                      summary: "Unsafe patch.",
                      proposedPatch,
                      changedFilesSuggested: ["../evil.txt"]
                    })
                  }
                }
              ],
              usage: { prompt_tokens: 300, completion_tokens: 100 }
            })
        }
      )
    ).rejects.toThrow("unsafe patch path");
  });

  it("rejects proposed patches with ambiguous path syntax", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: { queueTaskId: "pqtask_5", fabricTaskId: "task_5", title: "Ambiguous", goal: "Reject ambiguous patch." }
      }),
      "utf8"
    );
    const proposedPatch = [
      "diff --git a/file with spaces.txt b/file with spaces.txt",
      "--- a/file with spaces.txt",
      "+++ b/file with spaces.txt",
      "@@ -0,0 +1 @@",
      "+owned"
    ].join("\n");

    await expect(
      runDeepSeekWorkerCommand(
        parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath, "--patch-mode", "write"]),
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: "test-key" },
          fetchImpl: async () =>
            fakeJsonResponse({
              id: "resp_6",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      status: "patch_ready",
                      summary: "Ambiguous patch.",
                      proposedPatch,
                      changedFilesSuggested: ["file with spaces.txt"]
                    })
                  }
                }
              ],
              usage: { prompt_tokens: 300, completion_tokens: 100 }
            })
        }
      )
    ).rejects.toThrow("unsupported patch path syntax");
  });

  it("rejects direct apply unless the implementer report is patch_ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    const targetPath = join(dir, "hello.txt");
    writeFileSync(targetPath, "old\n", "utf8");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: { queueTaskId: "pqtask_6", fabricTaskId: "task_6", title: "Needs review", goal: "Do not apply." }
      }),
      "utf8"
    );
    const proposedPatch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");

    await expect(
      runDeepSeekWorkerCommand(
        parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath, "--patch-mode", "apply"]),
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: "test-key" },
          fetchImpl: async () =>
            fakeJsonResponse({
              id: "resp_7",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      status: "needs_review",
                      summary: "Patch needs review.",
                      proposedPatch,
                      changedFilesSuggested: ["hello.txt"]
                    })
                  }
                }
              ],
              usage: { prompt_tokens: 300, completion_tokens: 100 }
            })
        }
      )
    ).rejects.toThrow("patch-mode apply requires a patch_ready task report");
    expect(readFileSync(targetPath, "utf8")).toBe("old\n");
  });

  it("rejects direct apply from reviewer roles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: { queueTaskId: "pqtask_7", fabricTaskId: "task_7", title: "Reviewer", goal: "Review only." }
      }),
      "utf8"
    );
    const proposedPatch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -0,0 +1 @@",
      "+new"
    ].join("\n");

    await expect(
      runDeepSeekWorkerCommand(
        parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--role", "reviewer", "--output", outputPath, "--patch-mode", "apply"]),
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: "test-key" },
          fetchImpl: async () =>
            fakeJsonResponse({
              id: "resp_8",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      status: "patch_ready",
                      summary: "Reviewer suggested patch.",
                      proposedPatch,
                      changedFilesSuggested: ["hello.txt"]
                    })
                  }
                }
              ],
              usage: { prompt_tokens: 300, completion_tokens: 100 }
            })
        }
      )
    ).rejects.toThrow("patch-mode apply is only allowed for implementer");
  });

  it("rejects patch files outside the worker cwd or output directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: { queueTaskId: "pqtask_8", fabricTaskId: "task_8", title: "Patch file", goal: "Reject outside patch file." }
      }),
      "utf8"
    );
    const proposedPatch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -0,0 +1 @@",
      "+new"
    ].join("\n");

    await expect(
      runDeepSeekWorkerCommand(
        parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath, "--patch-mode", "write", "--patch-file", join(tmpdir(), "outside.patch")]),
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: "test-key" },
          fetchImpl: async () =>
            fakeJsonResponse({
              id: "resp_9",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      status: "patch_ready",
                      summary: "Patch ready.",
                      proposedPatch,
                      changedFilesSuggested: ["hello.txt"]
                    })
                  }
                }
              ],
              usage: { prompt_tokens: 300, completion_tokens: 100 }
            })
        }
      )
    ).rejects.toThrow("patch file must stay under cwd or output directory");
  });

  it("rejects patches that target symlinked path segments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const outside = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-outside-"));
    symlinkSync(outside, join(dir, "linked"), "dir");
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: { queueTaskId: "pqtask_9", fabricTaskId: "task_9", title: "Symlink", goal: "Reject symlink target." }
      }),
      "utf8"
    );
    const proposedPatch = [
      "diff --git a/linked/escape.txt b/linked/escape.txt",
      "--- a/linked/escape.txt",
      "+++ b/linked/escape.txt",
      "@@ -0,0 +1 @@",
      "+new"
    ].join("\n");

    await expect(
      runDeepSeekWorkerCommand(
        parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath, "--patch-mode", "write"]),
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: "test-key" },
          fetchImpl: async () =>
            fakeJsonResponse({
              id: "resp_10",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      status: "patch_ready",
                      summary: "Patch ready.",
                      proposedPatch,
                      changedFilesSuggested: ["linked/escape.txt"]
                    })
                  }
                }
              ],
              usage: { prompt_tokens: 300, completion_tokens: 100 }
            })
        }
      )
    ).rejects.toThrow("patch target uses symlink path segment");
  });

  it("rejects patches when the worker cwd is a symlink", async () => {
    const realDir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-real-"));
    const linkDir = join(tmpdir(), `agent-fabric-deepseek-link-${Date.now()}`);
    symlinkSync(realDir, linkDir, "dir");
    const packetPath = join(realDir, "packet.json");
    const outputPath = join(linkDir, "result.json");
    writeFileSync(join(realDir, "hello.txt"), "old\n", "utf8");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: { queueTaskId: "pqtask_10", fabricTaskId: "task_10", title: "Symlink cwd", goal: "Reject symlink cwd." }
      }),
      "utf8"
    );
    const proposedPatch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");

    await expect(
      runDeepSeekWorkerCommand(
        parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath, "--patch-mode", "write"]),
        {
          cwd: linkDir,
          env: { DEEPSEEK_API_KEY: "test-key" },
          fetchImpl: async () =>
            fakeJsonResponse({
              id: "resp_11",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      status: "patch_ready",
                      summary: "Patch ready.",
                      proposedPatch,
                      changedFilesSuggested: ["hello.txt"]
                    })
                  }
                }
              ],
              usage: { prompt_tokens: 300, completion_tokens: 100 }
            })
        }
      )
    ).rejects.toThrow("patch cwd is a symlink");
    expect(readFileSync(join(realDir, "hello.txt"), "utf8")).toBe("old\n");
  });

  it("dry-runs before apply so failed hunks leave files unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-fabric-deepseek-worker-"));
    const packetPath = join(dir, "packet.json");
    const outputPath = join(dir, "result.json");
    const targetPath = join(dir, "hello.txt");
    writeFileSync(targetPath, "old\n", "utf8");
    writeFileSync(
      packetPath,
      JSON.stringify({
        schema: "agent-fabric.task-packet.v1",
        task: { queueTaskId: "pqtask_11", fabricTaskId: "task_11", title: "Failed hunk", goal: "Do not partially apply." }
      }),
      "utf8"
    );
    const proposedPatch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-missing",
      "+new"
    ].join("\n");

    await expect(
      runDeepSeekWorkerCommand(
        parseDeepSeekWorkerArgs(["run-task", "--task-packet", packetPath, "--output", outputPath, "--patch-mode", "apply"]),
        {
          cwd: dir,
          env: { DEEPSEEK_API_KEY: "test-key" },
          fetchImpl: async () =>
            fakeJsonResponse({
              id: "resp_12",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      status: "patch_ready",
                      summary: "Patch ready.",
                      proposedPatch,
                      changedFilesSuggested: ["hello.txt"]
                    })
                  }
                }
              ],
              usage: { prompt_tokens: 300, completion_tokens: 100 }
            })
        }
      )
    ).rejects.toThrow(/patch exited|hunk|failed/i);
    expect(readFileSync(targetPath, "utf8")).toBe("old\n");
  });
});

function fakeJsonResponse(payload: unknown, options: { ok?: boolean; status?: number; retryAfter?: string } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === "retry-after" ? (options.retryAfter ?? null) : null)
    },
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}
