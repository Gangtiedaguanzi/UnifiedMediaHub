using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace UnifiedMediaHub.Core;

public sealed class HubRepository : IDisposable
{
    public string DatabasePath => connection.DataSource;
    private readonly SqliteConnection connection;
    private readonly object gate = new();
    public ScanCheckpoint? GetLatestScanProgress(string jobId)
    {
        lock (gate)
        {
            using var query = Command("SELECT generation,request_id,phase,committed_unique_item_count,observed_current,total,observed_rounds,observed_pages,updated_at,terminal_state FROM scan_progress WHERE job_id=$id ORDER BY rowid DESC LIMIT 1", null, ("$id", jobId));
            using var row = query.ExecuteReader();
            if (!row.Read()) return null;
            return new() { JobId = jobId, Generation = row.GetString(0), RequestId = row.GetString(1), Phase = row.GetString(2), CommittedUniqueItemCount = row.GetInt64(3),
                ObservedCurrent = row.IsDBNull(4) ? null : row.GetInt64(4), Total = row.IsDBNull(5) ? null : row.GetInt64(5), ObservedRounds = row.IsDBNull(6) ? null : row.GetInt64(6), ObservedPages = row.IsDBNull(7) ? null : row.GetInt64(7), UpdatedAt = DateTimeOffset.Parse(row.GetString(8)), TerminalState = row.GetString(9) };
        }
    }
    internal void SaveScanProgress(ScanCheckpoint value)
    {
        lock (gate) Execute("""
            INSERT INTO scan_progress(job_id,generation,request_id,phase,committed_unique_item_count,observed_current,total,observed_rounds,observed_pages,updated_at,terminal_state)
            VALUES($job,$generation,$request,$phase,$committed,$current,$total,$rounds,$pages,$time,$state)
            ON CONFLICT(job_id,generation) DO UPDATE SET phase=excluded.phase,committed_unique_item_count=excluded.committed_unique_item_count,
                observed_current=excluded.observed_current,total=excluded.total,observed_rounds=excluded.observed_rounds,observed_pages=excluded.observed_pages,updated_at=excluded.updated_at,terminal_state=excluded.terminal_state
            """, null, ("$job", value.JobId), ("$generation", value.Generation), ("$request", value.RequestId), ("$phase", value.Phase), ("$committed", value.CommittedUniqueItemCount),
            ("$current", value.ObservedCurrent), ("$total", value.Total), ("$rounds", value.ObservedRounds), ("$pages", value.ObservedPages), ("$time", value.UpdatedAt.ToString("O")), ("$state", value.TerminalState));
    }
    internal void RecoverScanProgress()
    {
        lock (gate) Execute("UPDATE scan_progress SET terminal_state='interrupted',phase='finished' WHERE terminal_state='running'");
    }
    public IReadOnlyList<ResourceMetrics> GetResourceSummaries(string jobId)
        => ReadResourceSummaries(jobId, false);
    public ResourceMetrics? GetLatestResourceSummary(string jobId)
    {
        ResourceMetrics? result = null;
        foreach (var batch in ReadResourceSummaries(jobId, true)) result = batch.AcrossBatches(result);
        return result;
    }
    private IReadOnlyList<ResourceMetrics> ReadResourceSummaries(string jobId, bool latestOnly)
    {
        lock (gate)
        {
            using var command = Command("SELECT request_id,operation,started_at,finished_at,sample_count,incomplete_count,peak_process_count,peak_private_commit,peak_working_set,operation_id FROM job_resources WHERE job_id=$id" + (latestOnly ? " AND operation_id=(SELECT operation_id FROM job_resources WHERE job_id=$id ORDER BY rowid DESC LIMIT 1)" : "") + " ORDER BY rowid", null, ("$id", jobId));
            using var reader = command.ExecuteReader(); var result = new List<ResourceMetrics>();
            while (reader.Read()) result.Add(new()
            {
                RequestId = reader.GetString(0), Operation = reader.GetString(1), StartedAt = DateTimeOffset.Parse(reader.GetString(2)), FinishedAt = DateTimeOffset.Parse(reader.GetString(3)),
                SampleCount = reader.GetInt32(4), IncompleteSampleCount = reader.GetInt32(5), PeakProcessCount = reader.IsDBNull(6) ? null : reader.GetInt32(6),
                PeakPrivateCommitBytes = reader.IsDBNull(7) ? null : reader.GetInt64(7), PeakWorkingSetBytes = reader.IsDBNull(8) ? null : reader.GetInt64(8), OperationId = reader.GetString(9)
            });
            return result;
        }
    }
    internal void SaveResourceSummary(string jobId, ResourceMetrics metrics)
    {
        if (metrics.FinishedAt == null) throw new ArgumentException("Only final resource summaries are persisted.");
        lock (gate) Execute("""
            INSERT INTO job_resources(job_id,request_id,operation,started_at,finished_at,sample_count,incomplete_count,peak_process_count,peak_private_commit,peak_working_set,operation_id)
            VALUES($job,$request,$operation,$start,$finish,$samples,$incomplete,$processes,$commit,$working,$operationId)
            ON CONFLICT(job_id,request_id) DO NOTHING
            """, null, ("$job", jobId), ("$request", metrics.RequestId), ("$operation", metrics.Operation), ("$start", metrics.StartedAt.ToString("O")), ("$finish", metrics.FinishedAt.Value.ToString("O")),
            ("$samples", metrics.SampleCount), ("$incomplete", metrics.IncompleteSampleCount), ("$processes", metrics.PeakProcessCount), ("$commit", metrics.PeakPrivateCommitBytes), ("$working", metrics.PeakWorkingSetBytes), ("$operationId", metrics.OperationId));
    }

    public HubRepository(string databasePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        var path = Path.GetFullPath(databasePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        connection.Open();
    }

    public void Initialize()
    {
        lock (gate)
        {
            Execute("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
            Execute("""
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL,
                    completeness TEXT NOT NULL, message TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, download_root TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS contents (key TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS memberships (
                    job_id TEXT NOT NULL REFERENCES jobs(id), content_key TEXT NOT NULL REFERENCES contents(key),
                    selected INTEGER NOT NULL, PRIMARY KEY(job_id,content_key));
                CREATE TABLE IF NOT EXISTS receipts (
                    job_id TEXT NOT NULL REFERENCES jobs(id), content_key TEXT NOT NULL, media_index INTEGER NOT NULL,
                    file_path TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
                    PRIMARY KEY(job_id,content_key,media_index,file_path));
                CREATE INDEX IF NOT EXISTS receipts_content ON receipts(content_key,media_index);
                CREATE INDEX IF NOT EXISTS receipts_digest ON receipts(lower(json_extract(data,'$.sha256')),json_extract(data,'$.bytes'));
                CREATE TABLE IF NOT EXISTS job_reasons (
                    job_id TEXT PRIMARY KEY REFERENCES jobs(id), reason_code TEXT NOT NULL,
                    job_updated_at TEXT NOT NULL, job_status TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS job_categories (
                    job_id TEXT PRIMARY KEY REFERENCES jobs(id), category TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS job_folders (
                    job_id TEXT PRIMARY KEY REFERENCES jobs(id), folder TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS folder_entries (
                    job_id TEXT NOT NULL REFERENCES jobs(id), folder_id TEXT NOT NULL, data TEXT NOT NULL,
                    PRIMARY KEY(job_id,folder_id));
                CREATE TABLE IF NOT EXISTS job_resources (
                    job_id TEXT NOT NULL REFERENCES jobs(id), request_id TEXT NOT NULL, operation TEXT NOT NULL,
                    started_at TEXT NOT NULL, finished_at TEXT NOT NULL, sample_count INTEGER NOT NULL, incomplete_count INTEGER NOT NULL,
                    peak_process_count INTEGER, peak_private_commit INTEGER, peak_working_set INTEGER, operation_id TEXT NOT NULL,
                    PRIMARY KEY(job_id,request_id));
                CREATE TABLE IF NOT EXISTS scan_progress (
                    job_id TEXT NOT NULL REFERENCES jobs(id), generation TEXT NOT NULL, request_id TEXT NOT NULL, phase TEXT NOT NULL,
                    committed_unique_item_count INTEGER NOT NULL, observed_current INTEGER, total INTEGER, observed_rounds INTEGER, observed_pages INTEGER,
                    updated_at TEXT NOT NULL, terminal_state TEXT NOT NULL, PRIMARY KEY(job_id,generation));
                CREATE TABLE IF NOT EXISTS bridge_items (
                    job_id TEXT NOT NULL REFERENCES jobs(id), content_key TEXT NOT NULL REFERENCES contents(key),
                    data TEXT NOT NULL, PRIMARY KEY(job_id,content_key));
                """);
        }
    }

    public HubJob CreateJob(SourceRequest source, string downloadRoot,string? category=null)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentException.ThrowIfNullOrWhiteSpace(downloadRoot);
        category=CategoryName.Validate(category);
        lock (gate)
        {
            var job = new HubJob { Id = Guid.NewGuid().ToString("N"), Source = Clone(source), DownloadRoot = Path.GetFullPath(downloadRoot), Category=category,CreatedAt = Now(), UpdatedAt = Now() };
            using var transaction=connection.BeginTransaction();
            Execute("INSERT INTO jobs(id,source,status,completeness,message,created_at,updated_at,download_root) VALUES ($id,$source,$status,$completeness,NULL,$created,$updated,$root)", transaction,
                ("$id", job.Id), ("$source", Serialize(job.Source)), ("$status", job.Status), ("$completeness", job.Completeness), ("$created", job.CreatedAt), ("$updated", job.UpdatedAt), ("$root", job.DownloadRoot));
            if(category.Length>0)Execute("INSERT INTO job_categories(job_id,category) VALUES($id,$category)",transaction,("$id",job.Id),("$category",category));
            transaction.Commit();return job;
        }
    }

    // A task keeps the folder of its first download, so retries and later batches land beside it.
    // Another task's identical name (same minute, same source) gets "_2", "_3", ...
    public string EnsureTaskFolder(string jobId,string name)
    {
        name=TaskFolders.Clean(name,80);
        if(name.Length==0)throw new ArgumentException("Empty task folder.",nameof(name));
        lock(gate)
        {
            using var transaction=connection.BeginTransaction();
            using(var existing=Command("SELECT folder FROM job_folders WHERE job_id=$id",transaction,("$id",jobId)))
                if(existing.ExecuteScalar() is string kept){transaction.Commit();return kept;}
            var candidate=name;
            for(var n=2;;n++)
            {
                using var taken=Command("SELECT 1 FROM job_folders WHERE folder=$folder COLLATE NOCASE LIMIT 1",transaction,("$folder",candidate));
                if(taken.ExecuteScalar()==null)break;
                var suffix="_"+n;candidate=TaskFolders.Clean(name,80-suffix.Length)+suffix;
            }
            Execute("INSERT INTO job_folders(job_id,folder) VALUES($id,$folder)",transaction,("$id",jobId),("$folder",candidate));
            transaction.Commit();return candidate;
        }
    }

    public void UpsertFolder(string jobId,WorkerFolder folder)
    {
        SavedFolders.Validate(folder);
        lock(gate)
        {
            var source=(GetJob(jobId)??throw new KeyNotFoundException()).Source;SavedFolders.ValidateDirectory(source);
            var existing=GetFolders(jobId);
            if(existing.Count>=SavedFolders.DirectoryLimit(source) && !existing.Any(f=>f.Id==folder.Id))throw new InvalidDataException("Folder directory limit exceeded.");
            Execute("INSERT INTO folder_entries(job_id,folder_id,data) VALUES($job,$id,$data) ON CONFLICT(job_id,folder_id) DO UPDATE SET data=excluded.data",null,("$job",jobId),("$id",folder.Id),("$data",Serialize(folder)));
        }
    }
    public IReadOnlyList<WorkerFolder> GetFolders(string jobId)
    {
        lock(gate)
        {
            using var command=Command("SELECT data FROM folder_entries WHERE job_id=$job ORDER BY rowid",null,("$job",jobId));
            using var reader=command.ExecuteReader();var folders=new List<WorkerFolder>();
            while(reader.Read())folders.Add(Deserialize<WorkerFolder>(reader.GetString(0)));
            return folders;
        }
    }
    public void ClearFolders(string jobId){lock(gate)Execute("DELETE FROM folder_entries WHERE job_id=$job",null,("$job",jobId));}

    public void SetScanLimit(string id,int maxItems)
    {
        if(maxItems<0 || maxItems>10000)throw new ArgumentOutOfRangeException(nameof(maxItems));
        lock(gate)
        {
            var job=GetJob(id)??throw new KeyNotFoundException();job.Source.MaxItems=maxItems;
            Execute("UPDATE jobs SET source=$source,updated_at=$updated WHERE id=$id",null,("$source",Serialize(job.Source)),("$updated",Now()),("$id",id));
        }
    }
    public IReadOnlyList<HubJob> ListJobs()
    {
        lock (gate)
        {
            using var command = Command(JobProjection + " ORDER BY j.created_at,j.id");
            using var reader = command.ExecuteReader();
            var jobs = new List<HubJob>();
            while (reader.Read()) jobs.Add(ReadJob(reader));
            return jobs;
        }
    }

    public HubJob? GetJob(string id)
    {
        lock (gate)
        {
            using var command = Command(JobProjection + " WHERE j.id=$id", null, ("$id", id));
            using var reader = command.ExecuteReader();
            return reader.Read() ? ReadJob(reader) : null;
        }
    }

    public void UpdateJob(string id, string status, string? message = null, string? completeness = null,string? reasonCode=null,bool clearReason=false)
    {
        if (status is not ("ready" or "scanning" or "paused" or "needs_action" or "downloading" or "completed" or "failed" or "interrupted")) throw new ArgumentException("Unknown job status.", nameof(status));
        if (completeness is not (null or "unknown" or "partial" or "complete")) throw new ArgumentException("Unknown scan completeness.", nameof(completeness));
        lock (gate)
        {
            var current=GetJob(id)??throw new KeyNotFoundException("Job does not exist.");
            var reason=clearReason?null:UserText.SafeCode(reasonCode)??current.ReasonCode;
            var updated=Now();
            using var transaction=connection.BeginTransaction();
            Execute("UPDATE jobs SET status=$status,message=$message,completeness=COALESCE($completeness,completeness),updated_at=$updated WHERE id=$id", transaction,
                ("$status",status),("$message",message),("$completeness",completeness),("$updated",updated),("$id",id));
            Execute("DELETE FROM job_reasons WHERE job_id=$id",transaction,("$id",id));
            if(reason is not null)Execute("INSERT INTO job_reasons(job_id,reason_code,job_updated_at,job_status) VALUES($id,$reason,$updated,$status)",transaction,
                ("$id",id),("$reason",reason),("$updated",updated),("$status",status));
            transaction.Commit();
        }
    }

    public void ConfirmBridge(string id)
    {lock(gate){var job=GetJob(id)??throw new KeyNotFoundException();if(job.Source.Kind!="bridge"||job.Source.Bridge==null)throw new InvalidOperationException("不是桥接任务。");job.Source.Bridge.Confirmed=true;Execute("UPDATE jobs SET source=$source,updated_at=$updated WHERE id=$id",null,("$source",Serialize(job.Source)),("$updated",Now()),("$id",id));}}
    public void ReviewBridgeAccount(string id,string? boundAccount)
    {lock(gate){var job=GetJob(id)??throw new KeyNotFoundException();if(job.Source.Kind!="bridge"||job.Source.Bridge is not {} info)return;if(info.ReviewAccountId==boundAccount)return;info.Confirmed=false;info.ReviewAccountId=boundAccount;info.ConfirmationRequired=!string.IsNullOrEmpty(boundAccount)&&info.ViewerId!=null&&info.ViewerId!=boundAccount;Execute("UPDATE jobs SET source=$source,updated_at=$updated WHERE id=$id",null,("$source",Serialize(job.Source)),("$updated",Now()),("$id",id));}}
    public bool BindAccount(string id, string accountId)
    {
        if (string.IsNullOrWhiteSpace(accountId) || accountId.Length > 200 || accountId.Any(char.IsControl)) throw new ArgumentException("Invalid account identity.", nameof(accountId));
        lock (gate)
        {
            var job = GetJob(id) ?? throw new KeyNotFoundException("Job does not exist.");
            if (!string.IsNullOrEmpty(job.Source.AccountId)) return job.Source.AccountId == accountId;
            job.Source.AccountId = accountId;
            return Execute("UPDATE jobs SET source=$source,updated_at=$updated WHERE id=$id", null, ("$source", Serialize(job.Source)), ("$updated", Now()), ("$id", id)) == 1;
        }
    }

    public void UpsertItems(string jobId, IEnumerable<ContentItem> items)
    {
        ArgumentNullException.ThrowIfNull(items);
        lock (gate)
        {
            var bridgeSnapshot=GetJob(jobId)?.Source.Kind=="bridge";
            using var transaction = connection.BeginTransaction();
            foreach (var incoming in items)
            {
                var key = ContentIdentity.KeyFor(incoming);
                if (incoming.Key.Length > 0 && incoming.Key != key) throw new ArgumentException("Content key does not match identity.", nameof(items));
                if (incoming.Media.Any(m => m.Index < 1) || incoming.Media.Select(m => m.Index).Distinct().Count() != incoming.Media.Count) throw new ArgumentException("Media indexes must be unique and positive.", nameof(items));
                ContentItem? existing;
                using (var read = Command("SELECT data FROM contents WHERE key=$key", transaction, ("$key", key)))
                    existing = read.ExecuteScalar() is string json ? Deserialize<ContentItem>(json) : null;
                var merged = Merge(existing, incoming);
                merged.Key = key;
                // Selection belongs to the job membership, never to canonical content.
                merged.Selected = true;
                Execute("INSERT INTO contents(key,data) VALUES($key,$data) ON CONFLICT(key) DO UPDATE SET data=excluded.data", transaction, ("$key", key), ("$data", Serialize(merged)));
                Execute("INSERT INTO memberships(job_id,content_key,selected) VALUES($job,$key,$selected) ON CONFLICT(job_id,content_key) DO NOTHING", transaction, ("$job", jobId), ("$key", key), ("$selected", incoming.Selected ? 1 : 0));
                if(bridgeSnapshot){var snapshot=Clone(incoming);snapshot.Key=key;Execute("INSERT INTO bridge_items(job_id,content_key,data) VALUES($job,$key,$data) ON CONFLICT(job_id,content_key) DO UPDATE SET data=excluded.data",transaction,("$job",jobId),("$key",key),("$data",Serialize(snapshot)));}
            }
            transaction.Commit();
        }
    }

    public IReadOnlyList<ContentItem> ListItems(string jobId)
    {
        lock (gate)
        {
            using var command = Command("SELECT COALESCE(b.data,c.data),m.selected FROM contents c JOIN memberships m ON c.key=m.content_key LEFT JOIN bridge_items b ON b.job_id=m.job_id AND b.content_key=m.content_key WHERE m.job_id=$job ORDER BY c.key", null, ("$job", jobId));
            using var reader = command.ExecuteReader();
            var items = new List<ContentItem>();
            while (reader.Read()) { var item = Deserialize<ContentItem>(reader.GetString(0)); item.Selected = reader.GetBoolean(1); items.Add(item); }
            return items;
        }
    }

    public void SetSelected(string jobId, string key, bool selected)
    {
        lock (gate)
        {
            if (Execute("UPDATE memberships SET selected=$selected WHERE job_id=$job AND content_key=$key", null, ("$selected", selected ? 1 : 0), ("$job", jobId), ("$key", key)) != 1) throw new KeyNotFoundException("Job content does not exist.");
        }
    }

    public void RecordReceipt(string jobId, DownloadReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        if (receipt.MediaIndex < 1 || receipt.Bytes < 0 || string.IsNullOrWhiteSpace(receipt.ContentKey)) throw new ArgumentException("Invalid receipt identity or byte count.", nameof(receipt));
        if (receipt.Status is not ("completed" or "skipped" or "failed")) throw new ArgumentException("Unknown receipt status.", nameof(receipt));
        lock (gate)
        {
            Execute("""
                INSERT INTO receipts(job_id,content_key,media_index,file_path,data,updated_at) VALUES($job,$key,$index,$path,$data,$updated)
                ON CONFLICT(job_id,content_key,media_index,file_path) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at
                """, null, ("$job", jobId), ("$key", receipt.ContentKey), ("$index", receipt.MediaIndex), ("$path", receipt.FilePath), ("$data", Serialize(receipt)), ("$updated", Now()));
        }
    }

    public IReadOnlyList<DownloadReceipt> ListReceipts(string jobId)
    {
        lock (gate)
        {
            using var command = Command("SELECT data FROM receipts WHERE job_id=$job ORDER BY content_key,media_index,file_path", null, ("$job", jobId));
            using var reader = command.ExecuteReader();
            var receipts = new List<DownloadReceipt>();
            while (reader.Read()) receipts.Add(Deserialize<DownloadReceipt>(reader.GetString(0)));
            return receipts;
        }
    }
    public IReadOnlyList<DownloadReceipt> FindDigestCandidates(string sha256,long bytes)
    {
        lock(gate){using var command=Command("SELECT data FROM receipts WHERE lower(json_extract(data,'$.sha256'))=$hash AND json_extract(data,'$.bytes')=$bytes GROUP BY content_key,media_index,file_path ORDER BY updated_at DESC",null,("$hash",sha256.ToLowerInvariant()),("$bytes",bytes));using var reader=command.ExecuteReader();var list=new List<DownloadReceipt>();while(reader.Read())list.Add(Deserialize<DownloadReceipt>(reader.GetString(0)));return list;}
    }

    public DownloadReceipt? FindVerifiedReceipt(string contentKey, int index)
    {
        lock (gate)
        {
            using var command = Command("SELECT data FROM receipts WHERE content_key=$key AND media_index=$index ORDER BY updated_at DESC", null, ("$key", contentKey), ("$index", index));
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var receipt = Deserialize<DownloadReceipt>(reader.GetString(0));
                if (receipt.Status is not ("completed" or "skipped") || receipt.Bytes <= 0) continue;
                try
                {
                    var file = new FileInfo(receipt.FilePath);
                    if (file.Exists && file.Length == receipt.Bytes) return receipt;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { /* Unreadable files cannot justify skipping a download. */ }
            }
            return null;
        }
    }

    public IReadOnlyList<DownloadReceipt> ListLatestReceipts(string jobId)
    {
        lock(gate)
        {
            using var command=Command("SELECT data FROM (SELECT data,ROW_NUMBER() OVER(PARTITION BY content_key,media_index ORDER BY updated_at DESC,rowid DESC) AS rank FROM receipts WHERE job_id=$job) WHERE rank=1",null,("$job",jobId));
            using var reader=command.ExecuteReader();var results=new List<DownloadReceipt>();
            while(reader.Read())results.Add(Deserialize<DownloadReceipt>(reader.GetString(0)));return results;
        }
    }

    public int RecoverInterruptedJobs()
    {
        lock (gate)
            return Execute("UPDATE jobs SET status='paused',message='Operation interrupted; resume requires explicit action.',updated_at=$updated WHERE status IN ('scanning','downloading','interrupted')", null, ("$updated", Now()));
    }

    public void Dispose() { lock (gate) connection.Dispose(); }

    private static ContentItem Merge(ContentItem? existing, ContentItem incoming)
    {
        var result = Clone(incoming);
        if (existing is null) return result;
        result.SourceUrl = Filled(result.SourceUrl, existing.SourceUrl);
        result.Title = Filled(result.Title, existing.Title);
        result.Author = Filled(result.Author, existing.Author);
        result.AuthorUrl = AuthorSources.TryGet(incoming, out _) ? incoming.AuthorUrl : existing.AuthorUrl;
        result.CreatedAt ??= existing.CreatedAt;
        result.ThumbnailUrl ??= existing.ThumbnailUrl;
        var merged = existing.Media.ToDictionary(m => m.Index, Clone);
        foreach (var asset in result.Media)
        {
            if (merged.TryGetValue(asset.Index, out var old))
            {
                asset.Kind = Filled(asset.Kind, old.Kind);
                if (string.IsNullOrWhiteSpace(asset.Url)) asset.Url = old.Url;
                asset.Extension = Filled(asset.Extension, old.Extension);
                asset.ExpectedBytes ??= old.ExpectedBytes;
                asset.Width ??= old.Width;
                asset.Height ??= old.Height;
            }
            merged[asset.Index] = asset;
        }
        result.Media = merged.Values.OrderBy(m => m.Index).ToList();
        result.MediaResolved = (incoming.MediaResolved || existing.MediaResolved) && merged.Keys.All(index =>
            (incoming.MediaResolved && incoming.Media.Any(m => m.Index == index)) ||
            (existing.MediaResolved && existing.Media.Any(m => m.Index == index)));
        return result;
    }

    private static string Filled(string value, string fallback) => string.IsNullOrEmpty(value) ? fallback : value;
    private static string Now() => DateTimeOffset.UtcNow.ToString("O");
    // Keep the original jobs column count: preview.2 uses a positional INSERT.
    // Older versions do not know about reasons; a changed job invalidates its old reason.
    private const string JobProjection="SELECT j.id,j.source,j.status,j.completeness,j.message,j.created_at,j.updated_at,j.download_root,r.reason_code,COALESCE(c.category,''),f.folder FROM jobs j LEFT JOIN job_reasons r ON r.job_id=j.id AND r.job_updated_at=j.updated_at AND r.job_status=j.status LEFT JOIN job_categories c ON c.job_id=j.id LEFT JOIN job_folders f ON f.job_id=j.id";
    private static string Serialize<T>(T value) => JsonSerializer.Serialize(value, HubJson.Options);
    private static T Deserialize<T>(string value) => JsonSerializer.Deserialize<T>(value, HubJson.Options) ?? throw new InvalidDataException("Missing persisted JSON value.");
    private static T Clone<T>(T value) => Deserialize<T>(Serialize(value));
    private static HubJob ReadJob(SqliteDataReader reader) => new()
    {
        Id = reader.GetString(0), Source = Deserialize<SourceRequest>(reader.GetString(1)), Status = reader.GetString(2), Completeness = reader.GetString(3),
        Message = reader.IsDBNull(4) ? null : reader.GetString(4), CreatedAt = reader.GetString(5), UpdatedAt = reader.GetString(6), DownloadRoot = reader.GetString(7),ReasonCode=reader.IsDBNull(8)?null:reader.GetString(8),Category=reader.GetString(9),TaskFolder=reader.IsDBNull(10)?null:reader.GetString(10)
    };

    private int Execute(string sql, SqliteTransaction? transaction = null, params (string Name, object? Value)[] parameters)
    { using var command = Command(sql, transaction, parameters); return command.ExecuteNonQuery(); }
    private SqliteCommand Command(string sql, SqliteTransaction? transaction = null, params (string Name, object? Value)[] parameters)
    {
        var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Transaction = transaction;
        foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Name, parameter.Value ?? DBNull.Value);
        return command;
    }
}
