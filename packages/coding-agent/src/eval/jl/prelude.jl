# OMP Julia prelude helpers (loaded once into the runner's top-level scope).

if !isdefined(Main, :__omp_prelude_loaded)
    global __omp_prelude_loaded = true
end

# -------------------------------------------------------------------------
# Internal-URL path resolution
# -------------------------------------------------------------------------

function __omp_url_decode(s::String)
    res = IOBuffer()
    i = 1
    len = ncodeunits(s)
    while i <= len
        c = Char(codeunit(s, i))
        if c == '%' && i + 2 <= len
            h_str = s[i+1:i+2]
            try
                b = parse(UInt8, h_str, base=16)
                write(res, b)
                i += 3
                continue
            catch
                # ignore format error
            end
        end
        write(res, c)
        i += 1
    end
    return String(take!(res))
end

function __omp_resolve_path(p::AbstractString)
    m = match(r"^([a-z][a-z0-9+.\-]*)://(.*)$"i, p)
    if m === nothing
        return abspath(p)
    end
    scheme = lowercase(string(m.captures[1]))
    roots_env = get(ENV, "PI_EVAL_LOCAL_ROOTS", "{}")
    roots = try
         Main.json_parse(roots_env)
    catch
         Dict{String, Any}()
    end
    root = get(roots, scheme, nothing)
    if root === nothing || isempty(root)
        error("Protocol paths are not supported by this helper: $p")
    end
    
    relative = __omp_url_decode(replace(string(m.captures[2]), '\\' => '/'))
    root_path = abspath(string(root))
    if isempty(relative)
        return root_path
    end
    
    if startswith(relative, '/') || ".." in split(relative, '/')
        error("Unsafe $scheme:// path (absolute or traversal): $p")
    end
    
    resolved = abspath(joinpath(root_path, relative))
    if resolved != root_path && !startswith(resolved, root_path * Base.Filesystem.path_separator)
        error("$scheme:// path escapes its root: $p")
    end
    return resolved
end

# -------------------------------------------------------------------------
# Display + status
# -------------------------------------------------------------------------


function display_image(base64_str::String, mime_type::String = "image/png")
    bundle = Dict(mime_type => base64_str)
    Main.emit_frame(Dict("type" => "display", "id" => Main.current_rid, "bundle" => bundle))
    return nothing
end

# -------------------------------------------------------------------------
# File helpers
# -------------------------------------------------------------------------

function Base.read(path::AbstractString, offset::Integer=1, limit::Union{Integer, Nothing}=nothing)
    resolved = __omp_resolve_path(string(path))
    content = open(resolved, "r") do io
        Base.read(io, String)
    end
    lines = split(content, '\n')
    if offset > 1 || limit !== nothing
        st = max(1, offset)
        en = limit !== nothing ? min(length(lines), st + limit - 1) : length(lines)
        if st <= length(lines)
            content = join(lines[st:en], '\n')
        else
            content = ""
        end
    end
    
    preview = length(content) > 500 ? content[1:500] : content
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "read",
                "path" => resolved,
                "chars" => length(content),
                "preview" => preview
            )
        )
    ))
    return content
end

function Base.write(path::AbstractString, content::Any)
    resolved = __omp_resolve_path(string(path))
    mkpath(dirname(resolved))
    open(resolved, "w") do io
        Base.write(io, string(content))
    end
    
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "write",
                "path" => resolved,
                "chars" => length(string(content))
            )
        )
    ))
    return resolved
end

function append(path, content)
    resolved = __omp_resolve_path(string(path))
    mkpath(dirname(resolved))
    open(resolved, "a") do f
        Base.write(f, string(content))
    end
    
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "append",
                "path" => resolved,
                "chars" => length(string(content))
            )
        )
    ))
    return resolved
end

function tree(path=".", max_depth=3, show_hidden=false)
    base = string(path)
    lines = String[]
    
    function walk(dir, prefix, depth)
        if depth > max_depth
            return
        end
        entries = try
            readdir(dir)
        catch
            String[]
        end
        if !show_hidden
            entries = filter(e -> !startswith(e, '.'), entries)
        end
        sort!(entries, by = e -> (ispath(joinpath(dir, e)) && isdir(joinpath(dir, e)) ? 0 : 1, lowercase(e)))
        
        for (i, name) in enumerate(entries)
            full = joinpath(dir, name)
            is_last = i == length(entries)
            is_dir = isdir(full)
            push!(lines, "$(prefix)$(is_last ? "└── " : "├── ")$(name)$(is_dir ? "/" : "")")
            if is_dir
                walk(full, prefix * (is_last ? "    " : "│   "), depth + 1)
            end
        end
    end
    
    walk(base, "", 1)
    out = join(lines, '\n')
    
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "tree",
                "path" => base,
                "lines" => length(lines)
            )
        )
    ))
    return out
end

function env(key=nothing, value=nothing)
    if key === nothing
        items = Dict{String, String}()
        for (k, v) in ENV
            items[k] = v
        end
        keys_list = sort(collect(keys(items)))
        Main.emit_frame(Dict(
            "type" => "display",
            "id" => Main.current_rid,
            "bundle" => Dict(
                "application/x-omp-status" => Dict(
                    "op" => "env",
                    "count" => length(items),
                    "keys" => keys_list[1:min(20, length(keys_list))]
                )
            )
        ))
        return items
    end
    
    k = string(key)
    if value !== nothing
        v = string(value)
        ENV[k] = v
        Main.emit_frame(Dict(
            "type" => "display",
            "id" => Main.current_rid,
            "bundle" => Dict(
                "application/x-omp-status" => Dict(
                    "op" => "env",
                    "key" => k,
                    "value" => v,
                    "action" => "set"
                )
            )
        ))
        return v
    end
    
    v = get(ENV, k, nothing)
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "env",
                "key" => k,
                "value" => v,
                "action" => "get"
            )
        )
    ))
    return v
end

# -------------------------------------------------------------------------
# Dynamic bridge proxy
# -------------------------------------------------------------------------

using Downloads

function __omp_call_bridge(name::String, args::Dict{String, Any})
    base_url = get(ENV, "PI_TOOL_BRIDGE_URL", nothing)
    token = get(ENV, "PI_TOOL_BRIDGE_TOKEN", nothing)
    session = get(ENV, "PI_TOOL_BRIDGE_SESSION", nothing)
    
    if base_url === nothing || token === nothing || session === nothing
        error("Tool bridge is not available in this cell.")
    end
    
    url = base_url
    if !endswith(url, "/v1/tool")
        url = endswith(url, "/") ? (url * "v1/tool") : (url * "/v1/tool")
    end

    payload_dict = Dict(
        "session" => session,
        "run" => Main.current_rid,
        "name" => name,
        "args" => args
    )
    payload_json = Main.json_serialize(payload_dict)
    
    headers = [
        "Authorization" => "Bearer $token",
        "Content-Type" => "application/json"
    ]
    
    io_out = IOBuffer()
    response = Downloads.request(
        url,
        method="POST",
        headers=headers,
        input=IOBuffer(payload_json),
        output=io_out
    )
    
    resp_str = String(take!(io_out))
    if response.status != 200
        error("Tool bridge call failed with status $(response.status): $resp_str")
    end
    
    parsed_resp = Main.json_parse(resp_str)
    
    ok = get(parsed_resp, "ok", false)
    if !ok
        err_msg = get(parsed_resp, "error", "Unknown error")
        error("Tool bridge error: $err_msg")
    end
    
    return get(parsed_resp, "value", nothing)
end

struct OmpToolProxy end

struct OmpToolCallable
    name::String
end

function (tc::OmpToolCallable)(args...; kwargs...)
    args_dict = Dict{String, Any}()
    if length(args) == 1 && args[1] isa AbstractDict
        for (k, v) in args[1]
            args_dict[string(k)] = v
        end
    end
    for (k, v) in kwargs
        args_dict[string(k)] = v
    end
    
    return __omp_call_bridge("tool:" * tc.name, args_dict)
end

function Base.getproperty(::OmpToolProxy, sym::Symbol)
    return OmpToolCallable(string(sym))
end

const tool = OmpToolProxy()

# -------------------------------------------------------------------------
# Agent calls
# -------------------------------------------------------------------------

function completion(prompt::String; kwargs...)
    args_dict = Dict{String, Any}("prompt" => prompt)
    for (k, v) in kwargs
        args_dict[string(k)] = v
    end
    return __omp_call_bridge("completion", args_dict)
end

function agent(prompt::String; kwargs...)
    args_dict = Dict{String, Any}("prompt" => prompt)
    for (k, v) in kwargs
        args_dict[string(k)] = v
    end
    return __omp_call_bridge("agent", args_dict)
end

function Base.log(message::AbstractString)
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "log",
                "message" => message
            )
        )
    ))
    return nothing
end

function phase(title::String)
    Main.emit_frame(Dict(
        "type" => "display",
        "id" => Main.current_rid,
        "bundle" => Dict(
            "application/x-omp-status" => Dict(
                "op" => "phase",
                "title" => title
            )
        )
    ))
    return nothing
end

# -------------------------------------------------------------------------
# Concurrency
# -------------------------------------------------------------------------

function _concurrency_limit()
    try
        limit_val = __omp_call_bridge("concurrency-bridge", Dict{String, Any}())
        return limit_val isa Number ? Int(limit_val) : 0
    catch
        return 0
    end
end

function _pool_map(items, fn)
    if isempty(items)
        return []
    end
    limit = _concurrency_limit()
    
    n = length(items)
    results = Vector{Any}(undef, n)
    errors = Dict{Int, Any}()
    
    sem = limit > 0 ? Channel{Nothing}(limit) : nothing
    
    @sync for i in 1:n
        if sem !== nothing
            put!(sem, nothing)
        end
        item = items[i]
        idx = i
        @async begin
            try
                res = fn(item)
                results[idx] = res
            catch err
                errors[idx] = err
            finally
                if sem !== nothing
                    take!(sem)
                end
            end
        end
    end
    
    if !isempty(errors)
        min_idx = minimum(keys(errors))
        throw(errors[min_idx])
    end
    return results
end

function parallel(thunks)
    return _pool_map(thunks, t -> t())
end

function pipeline(items, stages...)
    curr = collect(items)
    for stage in stages
        curr = _pool_map(curr, stage)
    end
    return curr
end

# -------------------------------------------------------------------------
# Budget
# -------------------------------------------------------------------------

struct OmpBudgetHardProxy end

function Base.getproperty(::OmpBudgetHardProxy, sym::Symbol)
    if sym === :total
        return __omp_call_bridge("budget:total", Dict{String, Any}())
    elseif sym === :spent
        return () -> __omp_call_bridge("budget:spent", Dict{String, Any}())
    elseif sym === :remaining
        return () -> __omp_call_bridge("budget:remaining", Dict{String, Any}())
    end
    error("Unknown budget hard metric: $sym")
end

struct OmpBudgetProxy
    hard::OmpBudgetHardProxy
end

function Base.getproperty(bp::OmpBudgetProxy, sym::Symbol)
    if sym === :hard
        return bp.hard
    elseif sym === :total
        return __omp_call_bridge("budget:total", Dict{String, Any}())
    elseif sym === :spent
        return () -> __omp_call_bridge("budget:spent", Dict{String, Any}())
    elseif sym === :remaining
        return () -> __omp_call_bridge("budget:remaining", Dict{String, Any}())
    end
    error("Unknown budget metric: $sym")
end

const budget = OmpBudgetProxy(OmpBudgetHardProxy())
