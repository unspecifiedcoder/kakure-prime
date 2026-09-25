export class ProofInputError extends Error {
  constructor(
    public readonly circuit: string,
    message: string,
  ) {
    super(`invalid input for ${circuit}: ${message}`);
    this.name = "ProofInputError";
  }
}

export class ProofError extends Error {
  constructor(
    public readonly circuit: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`proof failed for ${circuit}: ${message}`);
    this.name = "ProofError";
  }
}

export class ArtifactsMissingError extends Error {
  constructor(
    public readonly circuit: string,
    public readonly dir: string,
  ) {
    super(
      `no Sunspot build artifacts for circuit "${circuit}" under ${dir} ` +
        `(expected ${circuit}.json/.ccs/.pk/.vk) -- run \`just build-circuits\` (workstream A) first`,
    );
    this.name = "ArtifactsMissingError";
  }
}
