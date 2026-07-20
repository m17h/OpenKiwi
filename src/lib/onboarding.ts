export const ONBOARDING_VERSION = 1;
export const ONBOARDING_EXIT_MS = 330;

export function isEstablishedOpenKiwiInstall(input: {
  projects: number;
  knownThreads: number;
  hasStoredSettings: boolean;
  hasSkillsFolder: boolean;
}): boolean {
  return input.projects > 0 || input.knownThreads > 0 || input.hasStoredSettings || input.hasSkillsFolder;
}
