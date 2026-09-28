import { lstat, mkdir, open, readFile, realpath, stat, unlink, writeFile, } from "node:fs/promises";
import path from "node:path";
const CONFIG_DIRECTORY = ".codex";
const CONFIG_FILE = "config.toml";
export class ClientConnectionApplyError extends Error {
    rollback;
    constructor(cause, rollback) {
        super("CONNECT_APPLY_FAILED", { cause });
        this.name = "ClientConnectionApplyError";
        this.rollback = rollback;
    }
}
function tomlString(value) {
    return JSON.stringify(value);
}
function codexConfig(nodeExecutable, cliEntry, root) {
    const argumentsToml = [cliEntry, "mcp", "--root", root].map(tomlString).join(", ");
    return [
        "[mcp_servers.assertledger]",
        `command = ${tomlString(nodeExecutable)}`,
        `args = [${argumentsToml}]`,
        `cwd = ${tomlString(root)}`,
        "",
    ].join("\n");
}
async function existingConfigStatus(configPath, expectedContent) {
    try {
        const metadata = await lstat(configPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new Error("CONNECT_CONFIG_PATH_UNSAFE");
        }
        return (await readFile(configPath)).equals(Buffer.from(expectedContent, "utf8"))
            ? "UNCHANGED"
            : "CONFLICT";
    }
    catch (error) {
        if (error.code === "ENOENT")
            return "ABSENT";
        throw error;
    }
}
async function ensureSafeConfigDirectory(root, directory) {
    try {
        const metadata = await lstat(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error("CONNECT_CONFIG_PATH_UNSAFE");
        }
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        await mkdir(directory);
    }
    const resolvedDirectory = await realpath(directory);
    if (path.dirname(resolvedDirectory) !== root ||
        path.basename(resolvedDirectory) !== CONFIG_DIRECTORY) {
        throw new Error("CONNECT_CONFIG_PATH_UNSAFE");
    }
}
export async function createCodexProjectConfig(requestedRoot, requestedCliEntry, write) {
    const root = await realpath(requestedRoot);
    if (!(await stat(root)).isDirectory())
        throw new Error("REPOSITORY_ROOT_NOT_DIRECTORY");
    const cliEntry = await realpath(requestedCliEntry);
    if (!(await stat(cliEntry)).isFile() ||
        path.basename(cliEntry) !== "cli.js" ||
        path.basename(path.dirname(cliEntry)) !== "dist") {
        throw new Error("CONNECT_BUILD_REQUIRED");
    }
    const content = codexConfig(process.execPath, cliEntry, root);
    const configDirectory = path.join(root, CONFIG_DIRECTORY);
    const configPath = path.join(configDirectory, CONFIG_FILE);
    if (!write)
        return { status: "EMITTED", path: configPath, content };
    await ensureSafeConfigDirectory(root, configDirectory);
    const existing = await existingConfigStatus(configPath, content);
    if (existing !== "ABSENT")
        return { status: existing, path: configPath, content };
    try {
        await writeFile(configPath, content, { encoding: "utf8", flag: "wx" });
        return { status: "CREATED", path: configPath, content };
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        const raced = await existingConfigStatus(configPath, content);
        return { status: raced === "UNCHANGED" ? "UNCHANGED" : "CONFLICT", path: configPath, content };
    }
}
function mcpDescriptor(nodeExecutable, cliEntry, root) {
    return `${JSON.stringify({
        transport: "stdio",
        command: nodeExecutable,
        args: [cliEntry, "mcp", "--root", root],
        cwd: root,
    }, null, 2)}\n`;
}
function claudeCodeConfig(nodeExecutable, cliEntry, root) {
    return `${JSON.stringify({
        mcpServers: {
            assertledger: {
                type: "stdio",
                command: nodeExecutable,
                args: [cliEntry, "mcp", "--root", root],
            },
        },
    }, null, 2)}\n`;
}
async function resolveBuiltEntry(requestedCliEntry) {
    let cliEntry;
    let metadata;
    try {
        cliEntry = await realpath(requestedCliEntry);
        metadata = await stat(cliEntry);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new Error("CONNECT_BUILD_REQUIRED");
        }
        throw error;
    }
    if (!metadata.isFile() ||
        path.basename(cliEntry) !== "cli.js" ||
        path.basename(path.dirname(cliEntry)) !== "dist") {
        throw new Error("CONNECT_BUILD_REQUIRED");
    }
    return cliEntry;
}
async function resolveRepositoryRoot(requestedRoot) {
    const root = await realpath(requestedRoot);
    if (!(await stat(root)).isDirectory())
        throw new Error("REPOSITORY_ROOT_NOT_DIRECTORY");
    return root;
}
async function packagedSkill(cliEntry) {
    const skillPath = path.join(path.dirname(path.dirname(cliEntry)), "integrations", "skill", "SKILL.md");
    let metadata;
    try {
        metadata = await lstat(skillPath);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new Error("CONNECT_SKILL_REQUIRED");
        }
        throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("CONNECT_SKILL_PATH_UNSAFE");
    }
    try {
        return await readFile(skillPath, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new Error("CONNECT_SKILL_REQUIRED");
        }
        throw error;
    }
}
function clientArtifacts(client, root, cliEntry, skill) {
    if (client === "mcp") {
        return [
            {
                kind: "descriptor",
                path: null,
                content: mcpDescriptor(process.execPath, cliEntry, root),
            },
        ];
    }
    if (skill === undefined)
        throw new Error("CONNECT_SKILL_REQUIRED");
    if (client === "codex") {
        return [
            {
                kind: "configuration",
                path: path.join(root, ".codex", "config.toml"),
                content: codexConfig(process.execPath, cliEntry, root),
            },
            {
                kind: "skill",
                path: path.join(root, ".agents", "skills", "assertledger", "SKILL.md"),
                content: skill,
            },
        ];
    }
    return [
        {
            kind: "configuration",
            path: path.join(root, ".mcp.json"),
            content: claudeCodeConfig(process.execPath, cliEntry, root),
        },
        {
            kind: "skill",
            path: path.join(root, ".claude", "skills", "assertledger", "SKILL.md"),
            content: skill,
        },
    ];
}
function assertConnectionClient(client) {
    if (client !== "codex" && client !== "claude-code" && client !== "mcp") {
        throw new Error("CONNECT_CLIENT_UNSUPPORTED");
    }
}
function assertManagedConnectionClient(client) {
    if (client !== "codex" && client !== "claude-code") {
        throw new Error("DISCONNECT_CLIENT_UNSUPPORTED");
    }
}
async function validateParentPath(root, targetPath, errorCode) {
    const relativeParent = path.relative(root, path.dirname(targetPath));
    if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent))
        throw new Error(errorCode);
    let current = root;
    for (const component of relativeParent.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        try {
            const metadata = await lstat(current);
            if (!metadata.isDirectory() || metadata.isSymbolicLink())
                throw new Error(errorCode);
            if ((await realpath(current)) !== current)
                throw new Error(errorCode);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw error;
        }
    }
}
async function inspectArtifact(artifact, errorCode) {
    if (artifact.path === null)
        return "ABSENT";
    try {
        const metadata = await lstat(artifact.path);
        if (!metadata.isFile() || metadata.isSymbolicLink())
            throw new Error(errorCode);
        return (await readFile(artifact.path)).equals(Buffer.from(artifact.content, "utf8"))
            ? "UNCHANGED"
            : "CONFLICT";
    }
    catch (error) {
        if (error.code === "ENOENT")
            return "ABSENT";
        throw error;
    }
}
async function createSafeParents(root, targetPath) {
    const relativeParent = path.relative(root, path.dirname(targetPath));
    let current = root;
    for (const component of relativeParent.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        try {
            await mkdir(current);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        const metadata = await lstat(current);
        if (!metadata.isDirectory() ||
            metadata.isSymbolicLink() ||
            (await realpath(current)) !== current) {
            throw new Error("CONNECT_CONFIG_PATH_UNSAFE");
        }
    }
}
async function rollbackCreated(artifacts, removeArtifact) {
    const removed = [];
    const unresolved = [];
    for (const artifact of [...artifacts].reverse()) {
        if (artifact.path === null)
            continue;
        try {
            const state = await inspectArtifact(artifact, "CONNECT_CONFIG_PATH_UNSAFE");
            if (state !== "ABSENT") {
                await removeArtifact(artifact);
                removed.push(artifact.path);
            }
        }
        catch {
            unresolved.push(artifact.path);
        }
    }
    removed.sort((left, right) => left.localeCompare(right));
    unresolved.sort((left, right) => left.localeCompare(right));
    return { removed, unresolved };
}
export async function connectClient(requestedRoot, requestedCliEntry, client, write, dependencies = {}) {
    const plan = await planClientConnection(requestedRoot, requestedCliEntry, client);
    const { artifacts } = plan.result;
    const { states } = plan;
    if (plan.result.status === "CONFLICT") {
        return {
            ...plan.result,
            ...(plan.reasonCodes === undefined
                ? {}
                : {
                    reasonCodes: plan.reasonCodes,
                    diagnosticPaths: plan.diagnosticPaths ?? [],
                }),
        };
    }
    if (client === "mcp" || !write)
        return plan.result;
    const root = await resolveRepositoryRoot(requestedRoot);
    if (states.every((state) => state === "UNCHANGED")) {
        return { client, status: "UNCHANGED", artifacts };
    }
    const created = [];
    let pending;
    const openArtifact = dependencies.openArtifact ??
        ((artifact) => {
            if (artifact.path === null)
                throw new Error("CONNECT_PLAN_INCONSISTENT");
            return open(artifact.path, "wx");
        });
    const writeArtifact = dependencies.writeArtifact ??
        ((artifact, handle) => handle.writeFile(artifact.content, { encoding: "utf8" }));
    const removeArtifact = dependencies.removeArtifact ??
        ((artifact) => {
            if (artifact.path === null)
                throw new Error("CONNECT_PLAN_INCONSISTENT");
            return unlink(artifact.path);
        });
    try {
        for (const [index, artifact] of artifacts.entries()) {
            if (artifact.path === null || states[index] === "UNCHANGED")
                continue;
            await createSafeParents(root, artifact.path);
        }
        for (const [index, artifact] of artifacts.entries()) {
            if (artifact.path === null || states[index] === "UNCHANGED")
                continue;
            pending = artifact;
            const handle = await openArtifact(artifact);
            created.push(artifact);
            try {
                await writeArtifact(artifact, handle);
            }
            finally {
                await handle.close();
            }
            pending = undefined;
        }
    }
    catch (error) {
        const rollback = await rollbackCreated(created, removeArtifact);
        if (pending?.path !== null && pending?.path !== undefined && !created.includes(pending)) {
            try {
                if ((await inspectArtifact(pending, "CONNECT_CONFIG_PATH_UNSAFE")) !== "ABSENT") {
                    rollback.unresolved.push(pending.path);
                }
            }
            catch {
                rollback.unresolved.push(pending.path);
            }
            rollback.unresolved.sort((left, right) => left.localeCompare(right));
        }
        throw new ClientConnectionApplyError(error, rollback);
    }
    return { client, status: "CREATED", artifacts };
}
export async function planClientConnection(requestedRoot, requestedCliEntry, client) {
    assertConnectionClient(client);
    const root = await resolveRepositoryRoot(requestedRoot);
    const cliEntry = await resolveBuiltEntry(requestedCliEntry);
    if (client === "mcp") {
        return {
            result: {
                client,
                status: "EMITTED",
                artifacts: clientArtifacts(client, root, cliEntry, undefined),
            },
            states: ["ABSENT"],
        };
    }
    const artifacts = clientArtifacts(client, root, cliEntry, await packagedSkill(cliEntry));
    const states = [];
    const unsafePaths = [];
    const contentConflictPaths = [];
    for (const artifact of artifacts) {
        if (artifact.path === null)
            continue;
        try {
            await validateParentPath(root, artifact.path, "CONNECT_CONFIG_PATH_UNSAFE");
            const state = await inspectArtifact(artifact, "CONNECT_CONFIG_PATH_UNSAFE");
            states.push(state);
            if (state === "CONFLICT")
                contentConflictPaths.push(artifact.path);
        }
        catch (error) {
            if (!(error instanceof Error) || error.message !== "CONNECT_CONFIG_PATH_UNSAFE")
                throw error;
            states.push("CONFLICT");
            unsafePaths.push(artifact.path);
        }
    }
    const reasonCodes = [
        ...(unsafePaths.length === 0 ? [] : ["CONNECTION_TARGET_PATH_UNSAFE"]),
        ...(contentConflictPaths.length === 0 ? [] : ["CONNECTION_CONTENT_CONFLICT"]),
    ];
    const diagnosticPaths = [...unsafePaths, ...contentConflictPaths].sort((left, right) => left.localeCompare(right));
    return {
        result: {
            client,
            status: states.includes("CONFLICT") ? "CONFLICT" : "EMITTED",
            artifacts,
            ...(reasonCodes.length === 0 ? {} : { reasonCodes, diagnosticPaths }),
        },
        states,
        ...(reasonCodes.length === 0 ? {} : { reasonCodes, diagnosticPaths }),
    };
}
export async function disconnectClient(requestedRoot, requestedCliEntry, client, write) {
    assertManagedConnectionClient(client);
    const root = await resolveRepositoryRoot(requestedRoot);
    const cliEntry = await resolveBuiltEntry(requestedCliEntry);
    const artifacts = clientArtifacts(client, root, cliEntry, await packagedSkill(cliEntry));
    const states = [];
    for (const artifact of artifacts) {
        if (artifact.path === null)
            continue;
        await validateParentPath(root, artifact.path, "DISCONNECT_PATH_UNSAFE");
        states.push(await inspectArtifact(artifact, "DISCONNECT_PATH_UNSAFE"));
    }
    if (states.includes("CONFLICT"))
        return { client, status: "CONFLICT", artifacts };
    if (!write)
        return { client, status: "EMITTED", artifacts };
    if (states.every((state) => state === "ABSENT"))
        return { client, status: "ABSENT", artifacts };
    const removed = [];
    try {
        for (const [index, artifact] of artifacts.entries()) {
            if (artifact.path === null || states[index] === "ABSENT")
                continue;
            await unlink(artifact.path);
            removed.push(artifact);
        }
    }
    catch (error) {
        for (const artifact of [...removed].reverse()) {
            if (artifact.path === null)
                continue;
            try {
                await writeFile(artifact.path, artifact.content, { encoding: "utf8", flag: "wx" });
            }
            catch {
                // Preserve the original failure; rollback is best-effort under the trusted local stability model.
            }
        }
        throw error;
    }
    return { client, status: "REMOVED", artifacts };
}
//# sourceMappingURL=connection.js.map