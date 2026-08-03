const HERMES_PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const HERMES_PROFILE_HOME_PATTERN =
  /(?:^|\/)\.hermes\/profiles\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/?$/;
const HERMES_COMMAND_PROFILE_PATTERN =
  /(?:^|\s)(?:--profile|-p)\s+([A-Za-z0-9][A-Za-z0-9_-]{0,79})(?=\s|$)/;

export type EnrollmentAgentTarget = {
  agentCommand: string;
  profileIdentity: string;
};

export function resolveEnrollmentAgentTarget(input: {
  agentCommand: string;
  env?: NodeJS.ProcessEnv;
  profileIdentity?: string;
}): EnrollmentAgentTarget {
  const agentCommand = input.agentCommand.trim();
  if (!isHermesCommand(agentCommand)) {
    return {
      agentCommand,
      profileIdentity: input.profileIdentity?.trim() || "default",
    };
  }

  const configuredProfile = profileNameFromHermesCommand(agentCommand);
  const requestedProfile = validProfileName(input.profileIdentity);
  const activeProfile = profileNameFromHermesHome(input.env?.HERMES_HOME);
  const profileIdentity =
    configuredProfile ?? requestedProfile ?? activeProfile ?? "default";

  return {
    agentCommand:
      isBareHermesAcpCommand(agentCommand) && profileIdentity !== "default"
        ? `hermes --profile ${profileIdentity} acp`
        : agentCommand,
    profileIdentity,
  };
}

function isHermesCommand(command: string): boolean {
  return /^hermes(?:\s|$)/.test(command);
}

function isBareHermesAcpCommand(command: string): boolean {
  return /^hermes\s+acp$/.test(command);
}

function profileNameFromHermesCommand(command: string): string | undefined {
  return command.match(HERMES_COMMAND_PROFILE_PATTERN)?.[1];
}

function profileNameFromHermesHome(
  hermesHome: string | undefined,
): string | undefined {
  return hermesHome?.match(HERMES_PROFILE_HOME_PATTERN)?.[1];
}

function validProfileName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && HERMES_PROFILE_NAME_PATTERN.test(normalized)
    ? normalized
    : undefined;
}
