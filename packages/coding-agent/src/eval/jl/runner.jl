# OMP Julia runner — subprocess wrapper used by the coding-agent host.
# Persistent Julia process that speaks NDJSON over stdout and a custom TSV protocol on stdin.

using Base64

const ORIGINAL_STDOUT = stdout
const ORIGINAL_STDERR = stderr
const ORIGINAL_STDIN = stdin

# Redirect stdin/stdout/stderr to prevent cell prints from corrupting NDJSON
out_rd, out_wr = redirect_stdout()
err_rd, err_wr = redirect_stderr()
redirect_stdin(devnull)

global current_rid = nothing
const write_lock = ReentrantLock()

function json_parse(s::String)
    chars = collect(s)
    pos = 1
    len = length(chars)
    
    function skip_whitespace()
        while pos <= len && isspace(chars[pos])
            pos += 1
        end
    end
    
    function parse_value()
        skip_whitespace()
        if pos > len
            error("Unexpected EOF")
        end
        c = chars[pos]
        if c == '"'
            return parse_string()
        elseif c == '{'
            return parse_object()
        elseif c == '['
            return parse_array()
        elseif (c == 't' || c == 'f')
            return parse_boolean()
        elseif c == 'n'
            return parse_null()
        elseif c == '-' || isdigit(c)
            return parse_number()
        else
            error("Unexpected character at $pos: $c")
        end
    end
    
    function parse_string()
        pos += 1 # skip '"'
        res = IOBuffer()
        while pos <= len
            c = chars[pos]
            if c == '"'
                pos += 1 # skip '"'
                return String(take!(res))
            elseif c == '\\'
                pos += 1
                if pos > len; error("Unexpected EOF in string escape"); end
                esc = chars[pos]
                if esc == '"'
                    write(res, '"')
                elseif esc == '\\'
                    write(res, '\\')
                elseif esc == '/'
                    write(res, '/')
                elseif esc == 'b'
                    write(res, '\b')
                elseif esc == 'f'
                    write(res, '\f')
                elseif esc == 'n'
                    write(res, '\n')
                elseif esc == 'r'
                    write(res, '\r')
                elseif esc == 't'
                    write(res, '\t')
                elseif esc == 'u'
                    # parse 4 hex digits
                    hex = ""
                    for i in 1:4
                        pos += 1
                        hex *= chars[pos]
                    end
                    write(res, Char(parse(Int, hex, base=16)))
                else
                    write(res, esc)
                end
            else
                write(res, c)
            end
            pos += 1
        end
        error("Unterminated string")
    end
    
    function parse_object()
        pos += 1 # skip '{'
        obj = Dict{String, Any}()
        skip_whitespace()
        if pos <= len && chars[pos] == '}'
            pos += 1
            return obj
        end
        while true
            skip_whitespace()
            if pos > len || chars[pos] != '"'
                error("Expected string key in object at $pos")
            end
            key = parse_string()
            skip_whitespace()
            if pos > len || chars[pos] != ':'
                error("Expected ':' at $pos")
            end
            pos += 1 # skip ':'
            val = parse_value()
            obj[key] = val
            skip_whitespace()
            if pos > len
                error("Expected ',' or '}' in object at $pos")
            end
            c = chars[pos]
            if c == '}'
                pos += 1
                return obj
            elseif c == ','
                pos += 1
            else
                error("Expected ',' or '}' in object at $pos, got '$c'")
            end
        end
    end
    
    function parse_array()
        pos += 1 # skip '['
        arr = Any[]
        skip_whitespace()
        if pos <= len && chars[pos] == ']'
            pos += 1
            return arr
        end
        while true
            push!(arr, parse_value())
            skip_whitespace()
            if pos > len
                error("Expected ',' or ']' in array")
            end
            c = chars[pos]
            if c == ']'
                pos += 1
                return arr
            elseif c == ','
                pos += 1
            else
                error("Expected ',' or ']' in array at $pos, got '$c'")
            end
        end
    end
    
    function parse_boolean()
        s_slice = String(chars[pos:min(len, pos+4)])
        if startswith(s_slice, "true")
            pos += 4
            return true
        elseif startswith(s_slice, "false")
            pos += 5
            return false
        else
            error("Expected boolean at $pos")
        end
    end
    
    function parse_null()
        s_slice = String(chars[pos:min(len, pos+3)])
        if startswith(s_slice, "null")
            pos += 4
            return nothing
        else
            error("Expected null at $pos")
        end
    end
    
    function parse_number()
        start_pos = pos
        while pos <= len
            c = chars[pos]
            if isdigit(c) || c in ['.', '-', '+', 'e', 'E']
                pos += 1
            else
                break
            end
        end
        num_str = String(chars[start_pos:pos-1])
        val = tryparse(Int, num_str)
        if val !== nothing
            return val
        end
        val_f = tryparse(Float64, num_str)
        if val_f !== nothing
            return val_f
        end
        error("Invalid number format: $num_str")
    end
    
    val = parse_value()
    skip_whitespace()
    if pos <= len
        error("Extra data after JSON value at $pos")
    end
    return val
end

function json_serialize_string(s::AbstractString)
    res = IOBuffer()
    write(res, '"')
    for c in s
        if c == '"'
            write(res, "\\\"")
        elseif c == '\\'
            write(res, "\\\\")
        elseif c == '\n'
            write(res, "\\n")
        elseif c == '\r'
            write(res, "\\r")
        elseif c == '\t'
            write(res, "\\t")
        elseif c == '\f'
            write(res, "\\f")
        elseif c == '\b'
            write(res, "\\b")
        elseif UInt32(c) < 32
            d1 = div(UInt32(c), 16)
            d2 = rem(UInt32(c), 16)
            hex_chars = "0123456789abcdef"
            write(res, "\\u00" * hex_chars[d1 + 1] * hex_chars[d2 + 1])
        else
            write(res, c)
        end
    end
    write(res, '"')
    return String(take!(res))
end

function json_serialize(v)
    if v === nothing
        return "null"
    elseif v isa Bool
        return v ? "true" : "false"
    elseif v isa Number
        return string(v)
    elseif v isa AbstractString
        return json_serialize_string(v)
    elseif v isa Symbol
        return json_serialize_string(string(v))
    elseif v isa AbstractVector
        return "[" * join([json_serialize(x) for x in v], ",") * "]"
    elseif v isa AbstractDict
        parts = String[]
        for (k, val) in v
            push!(parts, json_serialize_string(string(k)) * ":" * json_serialize(val))
        end
        return "{" * join(parts, ",") * "}"
    else
        return json_serialize_string(repr(v))
    end
end

function emit_frame(frame)
    lock(write_lock) do
        println(ORIGINAL_STDOUT, json_serialize(frame))
        flush(ORIGINAL_STDOUT)
    end
end

function drain_stream(rd, kind)
    try
        while !eof(rd)
            line = readline(rd, keep=true)
            rid = current_rid
            if rid !== nothing && !isempty(line)
                emit_frame(Dict("type" => kind, "id" => rid, "data" => line))
            end
        end
    catch
        # ignore
    end
end

@async drain_stream(out_rd, "stdout")
@async drain_stream(err_rd, "stderr")

function build_mime_bundle(value)
    bundle = Dict{String, Any}()
    
    # text/plain
    io_plain = IOBuffer()
    show(io_plain, MIME"text/plain"(), value)
    bundle["text/plain"] = String(take!(io_plain))
    
    # rich mime types
    for mime_str in ["text/html", "text/markdown", "image/png", "image/jpeg"]
        m = MIME(Symbol(mime_str))
        if showable(m, value)
            try
                io = IOBuffer()
                if mime_str in ["image/png", "image/jpeg"]
                    b64_io = Base64EncodePipe(io)
                    show(b64_io, m, value)
                    close(b64_io)
                else
                    show(io, m, value)
                end
                bundle[mime_str] = String(take!(io))
            catch
                # ignore
            end
        end
    end
    
    if value isa AbstractDict || value isa AbstractVector
        try
            bundle["application/json"] = value
        catch
            # ignore
        end
    end
    
    return bundle
end

struct OmpDisplay <: AbstractDisplay end

function Base.display(d::OmpDisplay, value)
    rid = current_rid
    if rid !== nothing
        bundle = build_mime_bundle(value)
        emit_frame(Dict("type" => "display", "id" => rid, "bundle" => bundle))
    end
    return nothing
end

pushdisplay(OmpDisplay())

function emit_error(rid, err, bt)
    io = IOBuffer()
    showerror(io, err)
    err_str = String(take!(io))
    
    tb = String[]
    for frame in stacktrace(bt)
        file = string(frame.file)
        line = frame.line
        func = string(frame.func)
        push!(tb, "  at $func ($file:$line)")
    end
    
    emit_frame(Dict(
        "type" => "error",
        "id" => rid,
        "ename" => string(typeof(err)),
        "evalue" => err_str,
        "traceback" => tb
    ))
end

function should_display_result(parsed_expr)
    if parsed_expr isa Expr && parsed_expr.head === :block
        args = parsed_expr.args
        if !isempty(args)
            last_arg = args[end]
            if last_arg isa Expr
                if last_arg.head in [Symbol("="), :function, :struct, :using, :import, :const, :global, :local, :macro]
                    return false
                end
            end
        end
    end
    return true
end

function apply_request_runtime(cwd, env_pairs)
    try
        if !isempty(cwd)
            cd(cwd)
        end
    catch
        # ignore
    end
    
    managed_env_keys = [
        "PI_SESSION_FILE",
        "PI_ARTIFACTS_DIR",
        "PI_TOOL_BRIDGE_URL",
        "PI_TOOL_BRIDGE_TOKEN",
        "PI_TOOL_BRIDGE_SESSION",
        "PI_EVAL_LOCAL_ROOTS"
    ]
    for k in managed_env_keys
        delete!(ENV, k)
    end
    
    if !isempty(env_pairs)
        for pair in split(env_pairs, ' ')
            if !isempty(pair)
                try
                    k_b64, v_b64 = split(pair, ':', limit=2)
                    k = String(base64decode(string(k_b64)))
                    v = String(base64decode(string(v_b64)))
                    ENV[k] = v
                catch
                    # ignore
                end
            end
        end
    end
end

# Main loop
function main()
    while !eof(ORIGINAL_STDIN)
        line = readline(ORIGINAL_STDIN)
        if isempty(line)
            continue
        end
        parts = split(line, '\t')
        cmd = string(parts[1])
        if cmd == "exit"
            break
        elseif cmd == "run"
            if length(parts) < 7
                continue
            end
            rid = string(parts[2])
            cwd = String(base64decode(string(parts[3])))
            silent = string(parts[4]) == "1"
            store_history = string(parts[5]) == "1"
            env_pairs = string(parts[6])
            code = String(base64decode(string(parts[7])))
            
            global current_rid = rid
            emit_frame(Dict("type" => "started", "id" => rid))
            
            apply_request_runtime(cwd, env_pairs)
            
            exec_status = "ok"
            try
                parsed = Meta.parse("begin\n" * code * "\nend")
                if parsed isa Expr && parsed.head === :error
                    # Syntax error from parser
                    exec_status = "error"
                    emit_frame(Dict(
                        "type" => "error",
                        "id" => rid,
                        "ename" => "ParseError",
                        "evalue" => string(parsed.args[1]),
                        "traceback" => String[]
                    ))
                else
                    ans = Core.eval(Main, parsed)
                    if ans !== nothing && !silent && should_display_result(parsed)
                        bundle = build_mime_bundle(ans)
                        emit_frame(Dict("type" => "result", "id" => rid, "bundle" => bundle))
                    end
                end
            catch err
                exec_status = "error"
                emit_error(rid, err, catch_backtrace())
            end
            
            # Flush stdout and stderr writes before sending done frame
            flush(stdout)
            flush(stderr)
            # Yield to make sure async drain processes all writes
            sleep(0.01)
            
            emit_frame(Dict(
                "type" => "done",
                "id" => rid,
                "status" => exec_status,
                "executionCount" => 1,
                "cancelled" => false
            ))
            global current_rid = nothing
        end
    end
end

main()
