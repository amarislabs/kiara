import { Bumper, type BumperRecommendation } from "conventional-recommended-bump";
import { ResultAsync } from "neverthrow";
import type { ReleaseType } from "semver";
import semver from "semver";
import type { KiaraContext } from "#/kiara";
import { CWD } from "#/libs/const";
import { color, logger } from "#/libs/logger";

const RELEASE_TYPES: string[] = ["patch", "minor", "major"];

const CHOICES = {
    default: [...RELEASE_TYPES],
};

interface VersionSelectOption {
    label: string;
    value: string;
    hint?: string;
}

interface CommitReference {
    raw: string;
    action: string | null;
    owner: string | null;
    repository: string | null;
    issue: string;
    prefix: string;
}

interface CommitNote {
    title: string;
    text: string;
}

type CommitMeta = Record<string, string | null>;

interface CommitBase {
    merge: string | null;
    revert: CommitMeta | null;
    header: string | null;
    body: string | null;
    footer: string | null;
    notes: CommitNote[];
    mentions: string[];
    references: CommitReference[];
}

type Commit = CommitBase & CommitMeta;

/**
 * Get a list of incremental bumps from the current version
 * @param currentVersion The current version
 */
function getIncrementalBumps(currentVersion: string): VersionSelectOption[] {
    const types = CHOICES.default as ReleaseType[];

    const choices = types.map((increment) => ({
        label: `${increment} (${semver.inc(currentVersion, increment)})`,
        value: semver.inc(currentVersion, increment) as string,
        hint: semver.inc(currentVersion, increment) as string,
    })) as VersionSelectOption[];

    return choices;
}

/**
 * Prompt the user to select the version bump manually
 * @param context The Kiara context
 */
function promptManualVersion(context: KiaraContext): ResultAsync<string, Error> {
    const versions: VersionSelectOption[] = getIncrementalBumps(context.version.current);

    return ResultAsync.fromPromise(
        logger.prompt("Recommended version bump", {
            type: "select",
            options: versions,
            initial: versions[0].value,
            cancel: "reject",
        }),
        (error: unknown): Error =>
            new Error(error instanceof Error ? error.message : "Failed to select version bump")
    );
}

/**
 * Get an existing release type from the options.
 * @param currentVersion The current version
 * @param releaseType The release type
 */
function getVersionFromReleaseType(
    currentVersion: string,
    releaseType: ReleaseType
): ResultAsync<string, Error> {
    return ResultAsync.fromPromise(
        Promise.resolve(semver.inc(currentVersion, releaseType)),
        (error: unknown): Error =>
            new Error(`Failed to increment version with release type ${releaseType}: ${error}`)
    ).map((version: string | null): string => version as string);
}

export function getManualVersion(context: KiaraContext): ResultAsync<string, Error> {
    if (context.options.releaseType) {
        return getVersionFromReleaseType(
            context.version.current,
            context.options.releaseType
        ).andTee((version: string): void => {
            logger.info(
                `Using specified release type: ${color.cyan(context.options.releaseType)} -> ${color.cyan(version)}`
            );
        });
    }

    return promptManualVersion(context)
        .andTee((): void => console.log(" "))
        .andThen((nextVersion: string): ResultAsync<string, Error> => {
            return ResultAsync.fromPromise(
                Promise.resolve(nextVersion),
                (error: unknown): Error =>
                    new Error(`Failed to get selected version bump: ${error}`)
            );
        })
        .andTee((version: string): void => {
            logger.verbose(`Selected version bump: ${version}`);
        });
}

/**
 * Use conventional-recommended-bump to get the recommended version bump
 */
function getConventionalBump(): ResultAsync<BumperRecommendation, Error> {
    const conventionalOptions = {
        headerPattern: /^(\w*)(?:\((.*)\))?: (.*)$/,
        headerCorrespondence: ["type", "scope", "subject"],
        noteKeywords: ["BREAKING CHANGE"],
        revertPattern: /^(?:Revert|revert:)\s"?([\s\S]+?)"?\s*This reverts commit (\w*)\./i,
        revertCorrespondence: ["header", "hash"],
        breakingHeaderPattern: /^(\w*)(?:\((.*)\))?!: (.*)$/,
    };

    function analyzeBumpLevel(commits: Commit[]): BumperRecommendation {
        let level: 0 | 1 | 2 | 3 = 2;
        let breakings = 0;
        let features = 0;

        for (const commit of commits) {
            if (commit.notes.length > 0) {
                breakings += commit.notes.length;
                level = 0;
            } else if (commit.type === "feat") {
                features += 1;
                if (level === 2) {
                    level = 1;
                }
            }
        }

        return {
            level,
            reason:
                breakings === 1
                    ? `There is ${breakings} BREAKING CHANGE and ${features} features`
                    : `There are ${breakings} BREAKING CHANGES and ${features} features`,
        };
    }

    return ResultAsync.fromPromise(
        new Bumper()
            .commits({ path: CWD }, conventionalOptions)
            .bump(
                (commits: Commit[]): Promise<BumperRecommendation> =>
                    Promise.resolve(analyzeBumpLevel(commits))
            ),
        (error: unknown): Error => new Error(`Failed to get conventional bump: ${error}`)
    );
}

/**
 * Get the version based on the current version and the recommended bump
 * @param currentVersion The current version
 * @param recommended The recommended bump
 */
function getVersion(
    currentVersion: string,
    recommended: BumperRecommendation
): ResultAsync<string, Error> {
    return ResultAsync.fromPromise(
        Promise.resolve(semver.inc(currentVersion, recommended.releaseType as ReleaseType)),
        (error: unknown): Error => new Error(`Failed to get version: ${error}`)
    ).map((version: string | null): string => version as string);
}

export function getRecommendedVersion(context: KiaraContext): ResultAsync<string, Error> {
    // Split pipeline to conditionally add spacing based on prompt or options
    const basePipeline: ResultAsync<BumperRecommendation, Error> = getConventionalBump();
    const pipelineWithSpacing: ResultAsync<BumperRecommendation, Error> = context.options
        .bumpStrategy
        ? basePipeline
        : basePipeline.andTee((): void => console.log(" "));

    return pipelineWithSpacing
        .andTee((recommendation: BumperRecommendation) => {
            logger.verbose(`Received recommendation: ${JSON.stringify(recommendation)}`);
            logger.info(
                `Using recommended release type: ${color.cyan(recommendation.releaseType as string)} (${color.dim(recommendation.reason as string)})`
            );
        })
        .andThen(
            (recommendation: BumperRecommendation): ResultAsync<string, Error> =>
                getVersion(context.version.current, recommendation)
        );
}
