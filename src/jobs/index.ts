// Job table for background and stopped jobs.

export interface Job {
    id: number;
    pgid: number;
    pids: number[];
    command: string;
    status: "running" | "stopped" | "done";
    exitCode: number;
}

const jobs = new Map<number, Job>();
let currentJobId = 0;
let previousJobId = 0;

function nextId(): number {
    for (let i = 1; ; i++) {
        if (!jobs.has(i)) return i;
    }
}

export function addJob(pgid: number, pids: number[], command: string, status: "running" | "stopped"): Job {
    const id = nextId();
    const job: Job = { id, pgid, pids, command, status, exitCode: 0 };
    jobs.set(id, job);
    previousJobId = currentJobId;
    currentJobId = id;
    return job;
}

export function removeJob(id: number): void {
    jobs.delete(id);
    if (currentJobId === id) {
        currentJobId = previousJobId;
        previousJobId = 0;
    }
    if (previousJobId === id) {
        previousJobId = 0;
    }
}

export function getJob(id: number): Job | undefined {
    return jobs.get(id);
}

export function getJobBySpec(spec: string): Job | undefined {
    if (spec === "%%" || spec === "%+" || spec === "%") return jobs.get(currentJobId);
    if (spec === "%-") return jobs.get(previousJobId);
    const m = spec.match(/^%(\d+)$/);
    if (m) return jobs.get(parseInt(m[1]!, 10));
    // %?string — search command text
    const qm = spec.match(/^%\?(.+)$/);
    if (qm) {
        for (const job of jobs.values()) {
            if (job.command.includes(qm[1]!)) return job;
        }
    }
    return undefined;
}

export function getCurrentJob(): Job | undefined {
    return jobs.get(currentJobId);
}

export function getAllJobs(): Job[] {
    return [...jobs.values()].sort((a, b) => a.id - b.id);
}

export function markJobStopped(id: number, signal: number): void {
    const job = jobs.get(id);
    if (job) {
        job.status = "stopped";
        job.exitCode = 128 + signal;
    }
}

export function markJobDone(id: number, exitCode: number): void {
    const job = jobs.get(id);
    if (job) {
        job.status = "done";
        job.exitCode = exitCode;
    }
}

export function markJobRunning(id: number): void {
    const job = jobs.get(id);
    if (job) {
        job.status = "running";
    }
}

export function findJobByPid(pid: number): Job | undefined {
    for (const job of jobs.values()) {
        if (job.pids.includes(pid)) return job;
    }
    return undefined;
}

export function findJobByPgid(pgid: number): Job | undefined {
    for (const job of jobs.values()) {
        if (job.pgid === pgid) return job;
    }
    return undefined;
}

type ReapEntry = { pid: number; exitCode: number; stopped: boolean };

export function reapFinishedJobs(reapFn: () => ReapEntry[]): string[] {
    const notifications: string[] = [];
    const reaped = reapFn();
    for (const r of reaped) {
        const job = findJobByPid(r.pid);
        if (!job) continue;
        if (r.stopped) {
            markJobStopped(job.id, r.exitCode - 128);
        } else {
            markJobDone(job.id, r.exitCode);
            notifications.push(`[${job.id}]+  Done\t\t${job.command}`);
            removeJob(job.id);
        }
    }
    return notifications;
}
