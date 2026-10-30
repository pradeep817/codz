// Shared types: the framework-neutral project map, the universal endpoint
// object that skills build, change sets, and the adapter interface.

export const MAP_SCHEMA_VERSION = 1;

export type FrameworkId = 'nextjs' | 'flutter' | 'react-native' | 'react' | 'android' | 'ios' | 'generic';

export interface RouteInfo {
  name: string;
  path: string;
  params: string[];
  file: string;
}

export interface EndpointInfo {
  name: string;
  method: HttpMethod;
  path: string;
  response?: string;
  file: string;
  calledFrom: string[];
}

export interface ModelField {
  name: string;
  type: string;
  nullable: boolean;
}

export interface ModelInfo {
  name: string;
  file: string;
  fields: ModelField[];
}

export interface LocaleInfo {
  default?: string;
  languages: string[];
  files: string[];
  keyCount: number;
}

export interface BaseUrlInfo {
  name: string;
  value: string;
  file: string;
}

export interface GeneratedRecord {
  skill: string;
  file: string;
  symbol: string;
  inputHash: string;
}

/** Conventions are adapter-specific; every value is a plain string so the config file stays simple. */
export type Conventions = Record<string, string>;

export interface ProjectMap {
  schema: number;
  framework: FrameworkId;
  adapter: string;
  conventions: Conventions;
  routes: RouteInfo[];
  endpoints: EndpointInfo[];
  models: ModelInfo[];
  locales: LocaleInfo;
  baseUrls: BaseUrlInfo[];
  /** The HTTP client sets its own base URL (Dio BaseOptions, options.baseUrl), even when it is not a literal devtool can read. */
  clientBaseUrl?: boolean;
  stats: { files: number; byExtension: Record<string, number> };
  notes: string[];
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

// ---------- Inferred types (from JSON samples) ----------

export type InferredType =
  | { kind: 'string' }
  | { kind: 'date' }
  | { kind: 'int' }
  | { kind: 'double' }
  | { kind: 'bool' }
  | { kind: 'unknown' }
  | { kind: 'array'; item: InferredType }
  | { kind: 'object'; model: string };

export interface InferredField {
  /** Key exactly as it appears in JSON. */
  jsonName: string;
  type: InferredType;
  nullable: boolean;
}

export interface InferredModel {
  name: string;
  fields: InferredField[];
}

export interface QueryParam {
  name: string;
  type: InferredType;
}

export interface PathParam {
  name: string;
  /** Example value seen in the input, used only for messages. */
  example: string;
  type: 'int' | 'string';
}

/** The universal endpoint object every adapter receives. */
export interface EndpointSpec {
  name: string;
  method: HttpMethod;
  /** Full URL host part, e.g. https://api.example.com (may be empty when only a path was given). */
  origin: string;
  /** Path with {param} placeholders, e.g. /users/{id}/orders. */
  path: string;
  /** First meaningful path segment, e.g. "users". */
  resource: string;
  pathParams: PathParam[];
  queryParams: QueryParam[];
  /** Root response type; models referenced live in `models`. */
  response?: InferredType;
  /** True when the response sample was an envelope like {data: ..., meta: ...} and code must unwrap `data`. */
  unwrapData: boolean;
  request?: InferredType;
  /** All models needed by request and response, dependencies first. */
  models: InferredModel[];
  warnings: string[];
  /**
   * Set when the endpoint comes from an API spec (OpenAPI, Swagger): the path part of the spec's
   * server URL ('' when it has none, "/v1" for https://api.example.com/v1). The spec's server is a
   * stand-in for the app's own base URL (often another environment), so a client that already has a
   * base URL gets the path relative to it, never the spec's host.
   */
  serverPrefix?: string;
}

// ---------- Change sets ----------

export interface FileChange {
  /** Path relative to the project root, always with forward slashes. */
  path: string;
  /** Content hash before the change, or null when the file is created. */
  baseHash: string | null;
  before: string | null;
  /** New content, or null when the file is deleted. */
  after: string | null;
}

export interface ChangeSet {
  id: string;
  skill: string;
  summary: string[];
  warnings: string[];
  changes: FileChange[];
  generated: GeneratedRecord[];
  /** Existing files this change replaces on purpose (setup's new App.tsx, a rewritten model); see rewriteProblems. */
  rewrites?: string[];
}

export interface Capability {
  explain: boolean;
  apiAdd: boolean;
}

export interface AdapterContext {
  root: string;
  map: ProjectMap;
}

export interface Adapter {
  id: FrameworkId;
  version: string;
  capabilities: Capability;
  /** Supported setup, shown to the user and in the docs. */
  supportedSetup: string;
  scan(root: string, configConventions: Conventions): Promise<ProjectMap>;
  /** Formatter command for changed files, if the project has one. */
  formatCommand?(root: string, files: string[]): { cmd: string; args: string[] } | null;
  /** Analyzer command for changed files, if the project has one. */
  verifyCommand?(root: string, files: string[]): { cmd: string; args: string[] } | null;
  /** `overlay` holds files planned earlier in the same change; they are read before the disk. */
  planEndpoint?(ctx: AdapterContext, spec: EndpointSpec, overlay?: Map<string, string>, opts?: { replaceModels?: boolean; targetFile?: string }): Promise<PlannedEdits>;
  /** Architectures `setup` can create. Empty when the project already has an API layer. */
  architectures?(map: ProjectMap): ArchitectureOption[];
  /** Plans the files for an architecture, plus the conventions to save. */
  planSetup?(ctx: AdapterContext, choice: SetupChoice): SetupPlan;
  /** Creates a feature module (GetX: binding, controller, view and route). */
  planModule?(ctx: AdapterContext, opts: { name: string; initial?: boolean }, overlay?: Map<string, string>): PlannedEdits;
  /** Calls an endpoint from a module's controller, with loading, data and error state. */
  planWire?(ctx: AdapterContext, opts: { endpoint: string; module: string; noLoad?: boolean }, overlay?: Map<string, string>): PlannedEdits;
  /** Command to run after setup changed dependencies (for example `flutter pub get`). */
  afterSetup?(root: string): { cmd: string; args: string[]; label: string } | null;
}

export interface ArchitectureOption {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
}

export interface SetupChoice {
  architecture: string;
  baseUrl: string;
}

export interface SetupPlan extends PlannedEdits {
  conventions: Conventions;
  /** True when a dependency file (pubspec.yaml, package.json) changed. */
  dependenciesChanged: boolean;
}

export interface PlannedEdits {
  /** Full new content per path (relative). */
  files: Map<string, string>;
  /** Paths to delete (relative). */
  deletes?: Set<string>;
  summary: string[];
  warnings: string[];
  generated: GeneratedRecord[];
  /** Existing files replaced on purpose rather than edited in place (the guard in apply allows these). */
  rewrites?: string[];
  /** Endpoints and models this plan adds, so later steps in the same change can build on them. */
  endpoints?: EndpointInfo[];
  models?: ModelInfo[];
}

export class ToolError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}
