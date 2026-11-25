import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { isXtworkDesktop } from "../desktopFeatureVisibility";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { serverEnvironment } from "../state/server";

const developerFeaturesEnvironmentAtom = Atom.make((get) => {
  const primary = get(primaryEnvironmentIdAtom);
  if (primary !== null) return primary;
  const connected = [...get(environmentPresentations.presentationsAtom)].filter(
    ([, environment]) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  return connected.length === 1 ? connected[0]![0] : null;
});

const developerFeaturesStateAtom = Atom.make((get): boolean | null => {
  const environmentId = get(developerFeaturesEnvironmentAtom);
  if (environmentId === null) return null;
  const settings = get(serverEnvironment.settingsValueAtom(environmentId));
  if (settings === null) return null;
  return settings.developerFeaturesEnabled ?? false;
});

const developerFeaturesAtom = Atom.make((get) => get(developerFeaturesStateAtom) === true);

export function useDeveloperFeaturesEnvironmentId() {
  return useAtomValue(developerFeaturesEnvironmentAtom);
}

export function useDeveloperFeatures(): boolean {
  return useAtomValue(developerFeaturesAtom);
}

const unrestrictedDesktopFeaturesAtom = Atom.make(true);
const unrestrictedDesktopFeaturesStateAtom = Atom.make<boolean | null>(true);

export function useDesktopDeveloperFeatures(): boolean {
  return useAtomValue(isXtworkDesktop() ? developerFeaturesAtom : unrestrictedDesktopFeaturesAtom);
}

export function useDesktopDeveloperFeaturesState(): boolean | null {
  return useAtomValue(
    isXtworkDesktop() ? developerFeaturesStateAtom : unrestrictedDesktopFeaturesStateAtom,
  );
}

export function readDeveloperFeatures(): boolean {
  return appAtomRegistry.get(developerFeaturesAtom);
}

export function readDeveloperFeaturesState(): boolean | null {
  return appAtomRegistry.get(developerFeaturesStateAtom);
}
