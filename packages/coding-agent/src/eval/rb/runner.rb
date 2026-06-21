# frozen_string_literal: false
# OMP Ruby runner — subprocess wrapper used by the coding-agent host.
#
# Mirrors the Python runner (eval/py/runner.py): a persistent Ruby process that
# speaks NDJSON over stdin/stdout. The host writes one JSON request per line
# ({id, code, cwd?, env?, silent?}) and the runner replies with frames:
#   {type:"started", id}
#   {type:"stdout"|"stderr", id, data}
#   {type:"display"|"result", id, bundle}   # bundle = Jupyter-style MIME hash
#   {type:"error", id, ename, evalue, traceback:[...]}
#   {type:"done", id, status, executionCount, cancelled}
# A {type:"exit"} request (or stdin EOF) shuts the runner down.
#
# Each cell is evaluated in the persistent TOPLEVEL_BINDING so local variables,
# methods, and constants survive across cells. The last expression's value is
# auto-displayed (like IRB) unless it is nil, an assignment, or a definition.
#
# Frame channel isolation: the original stdout is dup'd onto a private IO for
# protocol frames, then fd 1/fd 2 are repointed at internal pipes. Child
# processes that inherit stdout/stderr land in those pipes and drain threads
# re-emit their bytes as stdout/stderr frames instead of corrupting the NDJSON
# channel. Ruby-level writes go through $stdout/$stderr proxies that emit frames
# synchronously so they order correctly with display output.

require "json"

# ---------------------------------------------------------------------------
# Frame channel + fd capture setup
# ---------------------------------------------------------------------------

$__omp_out_mutex = Mutex.new
$__omp_raw_stderr = (STDERR.dup rescue STDERR)
$__omp_current_rid = nil
$__omp_capture_rid = nil
$__omp_exec_count = 0
$__omp_active_exec = 0
$__omp_silent = false

begin
  $__omp_frame_io = STDOUT.dup
  $__omp_frame_io.sync = true
  __omp_stdout_cap_r, __omp_stdout_cap_w = IO.pipe
  STDOUT.reopen(__omp_stdout_cap_w)
  STDOUT.sync = true
  __omp_stdout_cap_w.close
  $__omp_stdout_capture_read = __omp_stdout_cap_r
rescue StandardError
  $__omp_frame_io = STDOUT
  ($__omp_frame_io.sync = true) rescue nil
  $__omp_stdout_capture_read = nil
end

begin
  __omp_stderr_cap_r, __omp_stderr_cap_w = IO.pipe
  STDERR.reopen(__omp_stderr_cap_w)
  STDERR.sync = true
  __omp_stderr_cap_w.close
  $__omp_stderr_capture_read = __omp_stderr_cap_r
rescue StandardError
  $__omp_stderr_capture_read = nil
end

# Protect the protocol channel from user code: read requests on a private dup of
# the original stdin, then repoint fd 0 at /dev/null so a user `gets`/`STDIN.gets`
# inside a cell sees EOF instead of consuming the next JSON request.
begin
  $__omp_proto_stdin = STDIN.dup
  STDIN.reopen(File.open(File::NULL, "r"))
rescue StandardError
  $__omp_proto_stdin = STDIN
end

# ---------------------------------------------------------------------------
# Frame writer + helpers (top-level private methods, available to user code)
# ---------------------------------------------------------------------------

def __omp_scrub(str)
  s = str.to_s
  begin
    s = s.encoding == Encoding::UTF_8 ? s : s.encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
  rescue StandardError
    s = s.dup.force_encoding(Encoding::UTF_8)
  end
  s.valid_encoding? ? s : s.scrub("\uFFFD")
end

def __omp_emit(frame)
  line =
    begin
      JSON.generate(frame)
    rescue StandardError
      JSON.generate(
        "type" => (frame["type"] || "stdout"),
        "id" => frame["id"],
        "data" => "<unserializable frame>\n",
      )
    end
  $__omp_out_mutex.synchronize do
    $__omp_frame_io.write(line)
    $__omp_frame_io.write("\n")
    $__omp_frame_io.flush
  end
rescue StandardError
  nil
end

def __omp_run_id
  $__omp_current_rid
end

def __omp_emit_stream(kind, text)
  rid = $__omp_current_rid
  if rid.nil?
    ($__omp_raw_stderr.write(text) rescue nil)
    return
  end
  __omp_emit("type" => kind, "id" => rid, "data" => __omp_scrub(text))
end

def __omp_emit_display(bundle, kind = "display")
  rid = $__omp_current_rid
  return if rid.nil?
  __omp_emit("type" => kind, "id" => rid, "bundle" => bundle)
end

def __omp_emit_status(op, data = {})
  status = { "op" => op.to_s }
  data.each { |k, v| status[k.to_s] = v }
  __omp_emit_display({ "application/x-omp-status" => status }, "display")
end

# Build a Jupyter-style MIME bundle for a value. Strings render as plain text,
# Hash/Array render as JSON (plus a text/plain repr) so the model sees structure,
# and anything else falls back to its inspect string. Objects may opt into a
# richer bundle by defining `to_omp_mime` returning a Hash of mime => value.
def __omp_mime_bundle(value)
  case value
  when String
    { "text/plain" => __omp_scrub(value) }
  when Hash, Array
    safe = begin
      JSON.parse(JSON.generate(value))
    rescue StandardError
      nil
    end
    if safe.nil?
      { "text/plain" => __omp_scrub(value.inspect) }
    else
      { "application/json" => safe, "text/plain" => __omp_scrub(value.inspect) }
    end
  when nil
    { "text/plain" => "nil" }
  else
    if value.respond_to?(:to_omp_mime)
      mime = (value.to_omp_mime rescue nil)
      mime.is_a?(Hash) ? mime : { "text/plain" => __omp_scrub(value.inspect) }
    else
      { "text/plain" => __omp_scrub(value.inspect) }
    end
  end
end

def __omp_present(value, kind = "display")
  __omp_emit_display(__omp_mime_bundle(value), kind)
end

# ---------------------------------------------------------------------------
# User stdout/stderr proxies — emit typed frames for the current request.
# ---------------------------------------------------------------------------

class OmpStreamProxy
  def initialize(kind, io, fileno)
    @kind = kind
    @io = io
    @fileno = fileno
  end

  def write(*args)
    total = 0
    args.each do |arg|
      s = arg.to_s
      next if s.empty?
      total += s.bytesize
      __omp_emit_stream(@kind, s)
    end
    total
  end

  def print(*args)
    args.each { |a| write(a) }
    nil
  end

  def <<(obj)
    write(obj)
    self
  end

  def puts(*args)
    if args.empty?
      write("\n")
    else
      args.each do |arg|
        if arg.is_a?(Array)
          arg.empty? ? write("\n") : puts(*arg)
        else
          s = arg.to_s
          write(s.end_with?("\n") ? s : "#{s}\n")
        end
      end
    end
    nil
  end

  def printf(fmt, *args)
    write(format(fmt, *args))
    nil
  end

  def write_nonblock(s, *)
    write(s)
  end

  def flush; self; end
  def sync; true; end
  def sync=(value); value; end
  def tty?; false; end
  def isatty; false; end
  def fileno; @fileno; end
  def to_io; @io; end
  def closed?; false; end
  def fsync; 0; end
  def external_encoding
    (@io.external_encoding rescue Encoding::UTF_8)
  end
end

# ---------------------------------------------------------------------------
# fd-1/fd-2 capture drains (child-process stdout/stderr) + parent watchdog
# ---------------------------------------------------------------------------

def __omp_start_capture_drain(io, kind)
  return if io.nil?
  Thread.new do
    loop do
      chunk =
        begin
          io.readpartial(65_536)
        rescue EOFError, IOError, Errno::EBADF
          break
        rescue StandardError
          break
        end
      next if chunk.nil? || chunk.empty?
      rid = $__omp_capture_rid
      if rid.nil?
        ($__omp_raw_stderr.write(chunk) rescue nil)
      else
        __omp_emit("type" => kind, "id" => rid, "data" => __omp_scrub(chunk))
      end
    end
  end
end

def __omp_start_parent_watchdog
  return unless RUBY_PLATFORM !~ /mswin|mingw|cygwin/
  return unless Process.respond_to?(:ppid)
  original = (Process.ppid rescue 0)
  return if original <= 1
  Thread.new do
    loop do
      begin
        Process.exit!(0) if Process.ppid != original
      rescue StandardError
        break
      end
      sleep 10
    end
  end
end

# ---------------------------------------------------------------------------
# Signal handling — SIGINT raises Interrupt only while a cell is executing.
# ---------------------------------------------------------------------------

def __omp_install_idle_sigint
  Signal.trap("INT", "IGNORE") rescue nil
end

def __omp_install_exec_sigint
  Signal.trap("INT", "DEFAULT") rescue nil
end

def __omp_begin_exec
  $__omp_active_exec += 1
  __omp_install_exec_sigint
end

def __omp_end_exec
  $__omp_active_exec -= 1 if $__omp_active_exec > 0
  __omp_install_idle_sigint if $__omp_active_exec.zero?
end

# ---------------------------------------------------------------------------
# Per-request runtime (cwd + managed env) + auto-result suppression
# ---------------------------------------------------------------------------

OMP_MANAGED_ENV_KEYS = %w[
  PI_SESSION_FILE
  PI_ARTIFACTS_DIR
  PI_TOOL_BRIDGE_URL
  PI_TOOL_BRIDGE_TOKEN
  PI_TOOL_BRIDGE_SESSION
  PI_EVAL_LOCAL_ROOTS
].freeze

def __omp_apply_request_runtime(req)
  cwd = req["cwd"]
  if cwd.is_a?(String) && !cwd.empty?
    (Dir.chdir(cwd) rescue nil)
    $LOAD_PATH.delete(cwd)
    $LOAD_PATH.unshift(cwd)
  end
  env = req["env"]
  if env.is_a?(Hash)
    OMP_MANAGED_ENV_KEYS.each do |key|
      next unless env.key?(key)
      value = env[key]
      if value.is_a?(String)
        ENV[key] = value
      elsif value.nil?
        ENV.delete(key)
      end
    end
  end
end

# Last value-bearing AST node types we should NOT auto-display (statements /
# definitions, mirroring IPython's "only display a trailing expression"). Falls
# back to displaying any non-nil value when the AST is unavailable.
OMP_NON_DISPLAY_NODES = %i[
  LASGN IASGN GASGN CVASGN DASGN OP_ASGN OP_CDECL CDECL MASGN CASGN
  DEFN DEFS CLASS MODULE SCLASS ALIAS UNDEF
].freeze

def __omp_ast_last(node)
  return nil unless node.is_a?(RubyVM::AbstractSyntaxTree::Node)
  case node.type
  when :SCOPE
    __omp_ast_last(node.children[2])
  when :BLOCK
    kids = node.children.compact
    kids.empty? ? nil : __omp_ast_last(kids.last)
  else
    node
  end
end

def __omp_should_display_result?(src)
  return true unless defined?(RubyVM::AbstractSyntaxTree)
  node =
    begin
      RubyVM::AbstractSyntaxTree.parse(src)
    rescue StandardError, SyntaxError
      return true
    end
  last = __omp_ast_last(node)
  return true if last.nil?
  !OMP_NON_DISPLAY_NODES.include?(last.type)
end

# ---------------------------------------------------------------------------
# Request dispatch
# ---------------------------------------------------------------------------

def __omp_emit_error(rid, exc, name_override = nil)
  ename = name_override || exc.class.name
  evalue = (exc.message.to_s rescue "")
  backtrace = (exc.backtrace || [])
  user_tb = backtrace.select { |l| l.include?("(eval)") }
  user_tb = backtrace.first(20) if user_tb.empty?
  traceback = ["#{ename}: #{evalue}"]
  user_tb.each { |line| traceback << "  #{line}" }
  __omp_emit(
    "type" => "error",
    "id" => rid,
    "ename" => ename,
    "evalue" => __omp_scrub(evalue),
    "traceback" => traceback.map { |l| __omp_scrub(l) },
  )
end

def __omp_handle_request(req)
  rid = req["id"].to_s
  $__omp_current_rid = rid
  $__omp_capture_rid = rid
  $__omp_silent = req["silent"] == true
  $__omp_exec_count += 1
  count = $__omp_exec_count
  __omp_emit("type" => "started", "id" => rid)

  status = "ok"
  cancelled = false
  begin
    begin
      __omp_apply_request_runtime(req)
      src = req["code"].to_s
    rescue Exception => e # rubocop:disable Lint/RescueException
      __omp_emit_error(rid, e)
      __omp_emit("type" => "done", "id" => rid, "status" => "error", "executionCount" => count, "cancelled" => false)
      return
    end

    __omp_begin_exec
    begin
      value = TOPLEVEL_BINDING.eval(src, "(eval)")
      unless $__omp_silent || value.nil? || !__omp_should_display_result?(src)
        __omp_present(value, "result")
      end
    rescue Interrupt => e
      cancelled = true
      status = "error"
      __omp_emit_error(rid, e, "Interrupt")
    rescue SystemExit => e
      status = "error"
      __omp_emit_error(rid, e)
    rescue Exception => e # rubocop:disable Lint/RescueException
      status = "error"
      __omp_emit_error(rid, e)
    ensure
      __omp_end_exec
    end

    __omp_emit("type" => "done", "id" => rid, "status" => status, "executionCount" => count, "cancelled" => cancelled)
  ensure
    $__omp_capture_rid = nil if $__omp_capture_rid == rid
    $__omp_current_rid = nil
  end
end

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def __omp_main
  $stdout = OmpStreamProxy.new("stdout", STDOUT, 1)
  $stderr = OmpStreamProxy.new("stderr", STDERR, 2)
  __omp_install_idle_sigint
  __omp_start_parent_watchdog
  __omp_start_capture_drain($__omp_stdout_capture_read, "stdout")
  __omp_start_capture_drain($__omp_stderr_capture_read, "stderr")

  $__omp_proto_stdin.each_line do |raw|
    line = raw.strip
    next if line.empty?
    req =
      begin
        JSON.parse(line)
      rescue JSON::ParserError => e
        __omp_emit(
          "type" => "error",
          "id" => "",
          "ename" => "ProtocolError",
          "evalue" => "Invalid JSON request: #{e.message}",
          "traceback" => [],
        )
        next
      end
    break if req.is_a?(Hash) && req["type"] == "exit"
    __omp_handle_request(req) if req.is_a?(Hash)
  end
end

__omp_main
