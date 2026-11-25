import { Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { readDeveloperFeatures, readDeveloperFeaturesState } from "./useDeveloperFeatures";

const state = vi.hoisted(() => ({
  registry: undefined as unknown as AtomRegistry.AtomRegistry,
  primary: undefined as unknown as Atom.Writable<string | null>,
  environments: undefined as unknown as Atom.Writable<ReadonlyMap<string, unknown>>,
  local: undefined as unknown as Atom.Writable<{ developerFeaturesEnabled?: boolean } | null>,
  remote: undefined as unknown as Atom.Writable<{ developerFeaturesEnabled?: boolean } | null>,
}));

vi.mock("../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  state.registry = AtomRegistry.make();
  return { appAtomRegistry: state.registry };
});

vi.mock("../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  state.primary = Atom.make<string | null>(null);
  return { primaryEnvironmentIdAtom: state.primary };
});

vi.mock("../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  state.environments = Atom.make<ReadonlyMap<string, unknown>>(new Map());
  return { environmentPresentations: { presentationsAtom: state.environments } };
});

vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  state.local = Atom.make<{ developerFeaturesEnabled?: boolean } | null>(null);
  state.remote = Atom.make<{ developerFeaturesEnabled?: boolean } | null>(null);
  return {
    serverEnvironment: {
      settingsValueAtom: (id: string) => (id === "local" ? state.local : state.remote),
    },
  };
});

beforeEach(() => {
  state.registry.set(state.primary, null);
  state.registry.set(state.environments, new Map());
  state.registry.set(state.local, null);
  state.registry.set(state.remote, null);
});

it("defaults off and tracks the primary settings even with another environment connected", () => {
  expect(readDeveloperFeaturesState()).toBeNull();
  state.registry.set(state.primary, "local");
  expect(readDeveloperFeaturesState()).toBeNull();
  state.registry.set(state.local, {});
  expect(readDeveloperFeaturesState()).toBe(false);
  expect(readDeveloperFeatures()).toBe(false);
  state.registry.set(state.remote, { developerFeaturesEnabled: true });
  expect(readDeveloperFeatures()).toBe(false);
  state.registry.set(state.local, { developerFeaturesEnabled: true });
  expect(readDeveloperFeaturesState()).toBe(true);
  expect(readDeveloperFeatures()).toBe(true);
  state.registry.set(state.local, { developerFeaturesEnabled: false });
  expect(readDeveloperFeaturesState()).toBe(false);
  expect(readDeveloperFeatures()).toBe(false);
});

it("uses a single connected fallback and ignores ambiguous environments", () => {
  expect(readDeveloperFeaturesState()).toBeNull();
  expect(readDeveloperFeatures()).toBe(false);
  const connected = { connection: { phase: "connected" }, serverConfig: {} };
  const offline = { connection: { phase: "disconnected" }, serverConfig: {} };
  state.registry.set(state.remote, { developerFeaturesEnabled: true });
  state.registry.set(
    state.environments,
    new Map([
      ["local", offline],
      ["remote", connected],
    ]),
  );
  expect(readDeveloperFeaturesState()).toBe(true);
  expect(readDeveloperFeatures()).toBe(true);
  state.registry.set(
    state.environments,
    new Map([
      ["local", connected],
      ["remote", connected],
    ]),
  );
  expect(readDeveloperFeaturesState()).toBeNull();
  expect(readDeveloperFeatures()).toBe(false);
});
