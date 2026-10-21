import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIG_FILES,
  hasOwnConfig,
  LEGACY_CONFIG_FILES,
  loadConfig,
  loadConfigWith,
  type LoadConfigOptions,
  type ResolvedConfig,
} from './config.js';
import { componentFiles } from './design-system.js';
import {
  findDesignSystemPackage,
  isWorkspaceRoot,
  PackageFinder,
  workspacePackageDirs,
  workspacePatterns,
} from './detect.js';
import { isInside, relativePath } from './util/paths.js';

/**
 * What marks the folder a file belongs to: the nearest one at or above it with a config,
 * a components.json, a package.json or an Nx project.json. The Claude Code hook finds a
 * file's project the same way, so `check` from a workspace root and the hook agree on
 * every file.
 */
export const PROJECT_MARKERS = [
  ...CONFIG_FILES,
  ...LEGACY_CONFIG_FILES,
  'components.json',
  'package.json',
  'project.json',
];

/** One folder of a workspace, with the config `check` would use when run from it. */
export interface Project {
  /** Absolute folder. */
  root: string;
  /** Relative to the workspace root, with forward slashes; `.` for the root itself. */
  dir: string;
  /** The package.json `name`, when it has one. */
  name?: string | undefined;
  config: ResolvedConfig;
}

/** A project found at a workspace root, with what zero config found in it. */
export interface DiscoveredProject extends Project {
  /** Component files its config matches. */
  componentFiles: number;
}

/**
 * A monorepo seen from its root: every workspace package with a design system (an app
 * that uses one, from source or a published library, or the design-system package
 * itself), and how to find the project of
 * any file in it. Without a design system at the root, `check`, `inspect` and the MCP
 * server work from here, each file checked by its own project's design system.
 */
export class Workspace {
  private readonly bare = new Map<string, Promise<Project>>();

  constructor(
    readonly root: string,
    /** What declares the packages, for `inspect`: `pnpm-workspace.yaml`, `nx.json`. */
    readonly source: string,
    /** Packages with a design system, sorted by folder. */
    readonly projects: DiscoveredProject[],
    /** Packages without one, relative to the root. */
    readonly others: string[],
    /** The config at the workspace root that projects without their own take on. */
    readonly configFile: string | undefined,
    private readonly options: LoadConfigOptions,
    /** The root's own config, with nothing found in it. */
    readonly rootConfig: ResolvedConfig,
    /** The configs of the packages without a design system, for their warnings. */
    private readonly otherConfigs: ResolvedConfig[] = [],
  ) {}

  /**
   * What the configs of the workspace's packages have to say ({@link ResolvedConfig.warnings}),
   * each once, as they were read when the workspace was found.
   */
  get warnings(): string[] {
    const configs = [this.rootConfig, ...this.projects.map((p) => p.config), ...this.otherConfigs];
    return [...new Set(configs.flatMap((c) => c.warnings ?? []))];
  }

  /**
   * The project `target` (a file or a folder) belongs to: the nearest folder at or above
   * it with one of the `PROJECT_MARKERS`, as the hook finds it, up to the workspace root. A folder that holds no design system still gets
   * its config, so its files are checked as `check` from that folder would check them.
   */
  async projectFor(target: string): Promise<Project> {
    const absolute = path.resolve(this.root, target);
    const dir = projectDirOf(absolute, this.root);
    const known = this.projects.find((p) => p.root === dir);
    if (known) return known;
    let project = this.bare.get(dir);
    if (!project) {
      project = dir === this.root ? Promise.resolve(this.rootProject()) : this.load(dir);
      this.bare.set(dir, project);
    }
    return project;
  }

  private rootProject(): Project {
    return { root: this.root, dir: '.', name: packageName(this.root), config: this.rootConfig };
  }

  /** A project's config read again, as `check` from its folder would read it. */
  configFor(project: Project): Promise<ResolvedConfig> {
    return project.root === this.root
      ? loadConfig(this.options)
      : loadProjectConfig(project.root, this.root, this.configFile, this.options);
  }

  private async load(dir: string): Promise<Project> {
    return {
      root: dir,
      dir: relativePath(this.root, dir) || '.',
      name: packageName(dir),
      config: await loadProjectConfig(dir, this.root, this.configFile, this.options),
    };
  }
}

/**
 * The config at `root`, or a `Workspace` when `root` is a monorepo root with no design
 * system of its own. The root is one project, as before, when a config file or
 * `--components` sets the components, when `--config`, `--tokens` or `--docs` is given,
 * or when zero config finds a design system there.
 */
export async function loadTarget(
  options: LoadConfigOptions,
): Promise<{ config: ResolvedConfig; workspace?: Workspace | undefined }> {
  const config = await loadConfig(options);
  const explicit =
    options.config !== undefined ||
    Boolean(options.components?.length) ||
    Boolean(options.tokens?.length) ||
    Boolean(options.docs?.length);
  if (explicit || config.configured || !isWorkspaceRoot(config.root)) return { config };
  if (config.detected !== undefined || (await componentFiles(config)).length) return { config };
  return { config, workspace: await discoverWorkspace(config, options) };
}

/** Every workspace package with a design system, and the rest by folder. */
async function discoverWorkspace(
  rootConfig: ResolvedConfig,
  options: LoadConfigOptions,
): Promise<Workspace> {
  const { root } = rootConfig;
  const patterns = workspacePatterns(root);
  const source = [
    patterns.source,
    fs.existsSync(path.join(root, 'nx.json')) ? 'nx.json' : '',
    fs.existsSync(path.join(root, 'turbo.json')) ? 'turbo.json' : '',
  ]
    .filter(Boolean)
    .join(', ');
  const projects: DiscoveredProject[] = [];
  const others: string[] = [];
  const otherConfigs: ResolvedConfig[] = [];
  for (const dir of workspacePackageDirs(root)) {
    const config = await loadProjectConfig(dir, root, rootConfig.configFile, options);
    const files = (await componentFiles(config)).length;
    const own = config.configFile !== undefined && config.configFile !== rootConfig.configFile;
    // An app on a published library (MUI) has its design system in node_modules.
    const library = config.libraries?.some((l) => l.dir !== undefined) ?? false;
    if (files || own || library) {
      projects.push({
        root: dir,
        dir: relativePath(root, dir),
        name: packageName(dir),
        config,
        componentFiles: files,
      });
    } else {
      others.push(relativePath(root, dir));
      if (config.warnings) otherConfigs.push(config);
    }
  }
  return new Workspace(
    root,
    source,
    projects,
    others,
    rootConfig.configFile,
    options,
    rootConfig,
    otherConfigs,
  );
}

/**
 * A project's config: its own config file, else the workspace root's, with paths relative to
 * the workspace root, read over the config its design-system package declares (a dependency with
 * `"onsystem"` in its package.json), else zero config. `loadConfig` from the project's folder
 * finds its own config and the package's the same way. CLI flags that apply to every project
 * carry over.
 */
function loadProjectConfig(
  dir: string,
  workspaceRoot: string,
  rootConfigFile: string | undefined,
  options: LoadConfigOptions,
): Promise<ResolvedConfig> {
  const shared = {
    cwd: options.cwd,
    includeDesignSystem: options.includeDesignSystem,
    jsonConfigOnly: options.jsonConfigOnly,
  };
  // One finder and one look through the dependencies, shared with the load.
  const packages = new PackageFinder(dir);
  if (!rootConfigFile || hasOwnConfig(dir)) {
    return loadConfigWith({ ...shared, root: dir }, { packages });
  }
  const lookup = findDesignSystemPackage(dir, packages);
  // A declaration that cannot be read is reported from the project's own load.
  if (lookup?.problems.length) {
    return loadConfigWith({ ...shared, root: dir }, { packages, lookup });
  }
  return loadConfigWith(
    { ...shared, root: dir, config: rootConfigFile, base: workspaceRoot },
    { packages, lookup },
  );
}

/** The nearest folder at or above `target` (a file or folder) with a project marker, up to `root`. */
export function projectDirOf(target: string, root: string): string {
  let dir = isDirectory(target) ? target : path.dirname(target);
  while (isInside(root, dir) && dir !== root) {
    if (hasProjectMarker(dir)) return dir;
    dir = path.dirname(dir);
  }
  return root;
}

/**
 * The folder to serve `target` (an absolute file or folder, which need not exist yet) from,
 * found by walking up from it: the nearest folder with a project marker, as the Claude Code
 * hook finds a file's project, or the monorepo root above that folder when there is one, as
 * a client that reports the repository as its workspace would have the server started.
 * `loadTarget` there serves the root's own design system, or each project in it. The home
 * folder and the filesystem root are never one. Undefined when no other folder up to the
 * filesystem root has a project marker.
 */
export function findProjectRoot(target: string, home = os.homedir()): string | undefined {
  // Never the home folder or the filesystem root: a stray ~/package.json is not a project,
  // and serving it would scan everything under it.
  const skipped = (dir: string) => dir === path.dirname(dir) || samePath(dir, home);
  let dir = isDirectory(target) ? target : path.dirname(target);
  while (skipped(dir) || !hasProjectMarker(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  for (let up = dir; up !== path.dirname(up); up = path.dirname(up)) {
    if (!skipped(up) && isWorkspaceRoot(up)) return up;
  }
  return dir;
}

function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

/** Whether `dir` holds one of the `PROJECT_MARKERS`. */
export function hasProjectMarker(dir: string): boolean {
  return PROJECT_MARKERS.some((name) => fs.existsSync(path.join(dir, name)));
}

function packageName(dir: string): string | undefined {
  try {
    const name = (
      JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
      }
    ).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
