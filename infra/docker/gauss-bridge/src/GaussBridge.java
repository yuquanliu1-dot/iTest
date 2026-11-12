import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.Writer;
import java.math.BigDecimal;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.Executors;

/**
 * GaussDB 100 (Zenith) JDBC bridge: no driver exists in the Node ecosystem, so the api forwards SQL over HTTP to JDBC.
 *
 * Protocol:
 *   GET  /healthz            → 200 {"ok":true}
 *   POST /query              → 200 {"rows":[{...},...], "truncated":false}
 *        body {host, port, user, password, schema, sql, params:[]}
 *        failures: 400 {"error":"..."} (SQLException, GS code + SQLState passed through)
 *                  401 token mismatch / 405 non-POST / 413 body over limit
 *                  502 {"error":"..."} (cannot reach the target database, loginTimeout fallback)
 *
 * Design: a connection per request (targets differ per environment object, no pooling); explicit timeouts (driver default 0 = wait forever);
 * zero third-party dependencies (hand-written minimal JSON). Auth: GAUSS_BRIDGE_TOKEN unset = no auth (reachable only on the compose network).
 */
public final class GaussBridge {

  private static final String DRIVER = "com.huawei.gauss.jdbc.ZenithDriver";
  private static final int PORT = envInt("GAUSS_BRIDGE_PORT", 8080);
  private static final String TOKEN = System.getenv("GAUSS_BRIDGE_TOKEN"); // null/empty = no auth
  private static final int LOGIN_TIMEOUT_SEC = 10;
  private static final String SOCKET_TIMEOUT = "30"; // seconds (driver property; =0 waits forever)
  private static final int QUERY_TIMEOUT_SEC = 60;
  private static final int MAX_BODY = 1 << 20; // 1MB
  private static final int MAX_ROWS = 10_000;  // fallback truncation (guards against OOM on large results without LIMIT)

  public static void main(String[] args) throws Exception {
    try {
      Class.forName(DRIVER);
    } catch (ClassNotFoundException e) {
      System.err.println("FATAL: driver not on classpath: " + DRIVER);
      System.exit(2);
    }
    DriverManager.setLoginTimeout(LOGIN_TIMEOUT_SEC);

    HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);
    server.createContext("/healthz", GaussBridge::handleHealthz);
    server.createContext("/query", GaussBridge::handleQuery);
    server.setExecutor(Executors.newFixedThreadPool(8));
    server.start();
    System.out.println("gauss-bridge up on :" + PORT + " token=" + (TOKEN == null || TOKEN.isEmpty() ? "off" : "on"));
  }

  private static void handleHealthz(HttpExchange ex) throws IOException {
    respond(ex, 200, "{\"ok\":true}");
  }

  private static void handleQuery(HttpExchange ex) throws IOException {
    long started = System.currentTimeMillis();
    String target = "";
    String schema = "";
    int rows = -1;
    try {
      if (TOKEN != null && !TOKEN.isEmpty() && !TOKEN.equals(ex.getRequestHeaders().getFirst("x-bridge-token"))) {
        respond(ex, 401, err("unauthorized"));
        return;
      }
      if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
        respond(ex, 405, err("method not allowed"));
        return;
      }
      byte[] body = readBody(ex.getRequestBody());
      Map<String, Object> req = castMap(MiniJson.parse(new String(body, "UTF-8")), "body");
      String host = requireStr(req, "host");
      int port = requireInt(req, "port");
      String user = requireStr(req, "user");
      String password = str(req.get("password"));
      schema = str(req.get("schema"));
      String sql = requireStr(req, "sql");
      List<Object> params = req.containsKey("params") && req.get("params") instanceof List
          ? (List<Object>) req.get("params") : null;
      target = host + ":" + port;

      String result = queryToJson(host, port, user, password, schema, sql, params);
      respond(ex, 200, result);
      System.out.println("query " + target + " schema=" + schema + " ok rows<=MAX in "
          + (System.currentTimeMillis() - started) + "ms");
    } catch (IllegalArgumentException e) {
      respond(ex, 400, err(e.getMessage()));
      System.out.println("query " + target + " bad-request: " + e.getMessage());
    } catch (SQLException e) {
      // GS-xxxx + SQLState passed through as-is; the api-side probeErrorText displays them directly
      respond(ex, 400, err(e.getMessage() + " (SQLState=" + e.getSQLState() + ")"));
      System.out.println("query " + target + " sql-error: " + e.getMessage());
    } catch (ConnectException | SocketTimeoutException e) {
      respond(ex, 502, err("connect failed: " + e));
      System.out.println("query " + target + " connect-failed: " + e);
    } catch (IOException e) {
      respond(ex, 502, err("connect failed: " + e));
      System.out.println("query " + target + " io-error: " + e);
    } catch (Exception e) {
      respond(ex, 500, err(String.valueOf(e)));
      System.out.println("query " + target + " error: " + e);
    }
  }

  /** Connection + prepared-statement execution per request; the result is assembled into {"rows":[...],"truncated":bool}. */
  private static String queryToJson(String host, int port, String user, String password,
                                    String schema, String sql, List<Object> params) throws SQLException, IOException {
    preflightTcp(host, port); // the driver's TCP connect phase can wait forever (setLoginTimeout demonstrably doesn't govern it), so self-guard first
    Properties props = new Properties();
    props.setProperty("user", user);
    if (password != null) props.setProperty("password", password);
    // GaussDB 100's "database name" = schema; both properties are set (which one the driver honors depends on the version; either is harmless)
    if (schema != null && !schema.isEmpty()) {
      props.setProperty("databaseName", schema);
      props.setProperty("defaultSchema", schema);
    }
    props.setProperty("loginTimeout", String.valueOf(LOGIN_TIMEOUT_SEC)); // the driver only honors the property form
    props.setProperty("socketTimeout", SOCKET_TIMEOUT);

    StringBuilder out = new StringBuilder(1024);
    try (Connection conn = DriverManager.getConnection("jdbc:zenith:@" + host + ":" + port, props);
         PreparedStatement st = conn.prepareStatement(sql)) {
      st.setQueryTimeout(QUERY_TIMEOUT_SEC);
      if (params != null) {
        for (int i = 0; i < params.size(); i++) setObject(st, i + 1, params.get(i));
      }
      try (ResultSet rs = st.executeQuery()) {
        ResultSetMetaData meta = rs.getMetaData();
        int n = meta.getColumnCount();
        String[] names = new String[n + 1];
        for (int i = 1; i <= n; i++) names[i] = meta.getColumnLabel(i);
        out.append("{\"rows\":[");
        int count = 0;
        boolean truncated = false;
        while (rs.next()) {
          if (count >= MAX_ROWS) { truncated = true; break; }
          if (count > 0) out.append(',');
          out.append('{');
          for (int i = 1; i <= n; i++) {
            if (i > 1) out.append(',');
            out.append('"').append(escape(names[i])).append("\":");
            writeJsonValue(out, rs.getObject(i));
          }
          out.append('}');
          count++;
        }
        out.append("],\"truncated\":").append(truncated).append('}');
      }
    }
    return out.toString();
  }

  // ---------- JDBC values → JSON-safe values ----------

  /** TCP pre-connect probe: throws directly if the connection fails within 5s (ConnectException/SocketTimeoutException are both IOException subclasses; the handler maps them to 502). */
  private static void preflightTcp(String host, int port) throws IOException {
    try (java.net.Socket sock = new java.net.Socket()) {
      sock.connect(new InetSocketAddress(host, port), 5000);
    }
  }

  private static void setObject(PreparedStatement st, int idx, Object v) throws SQLException {
    st.setObject(idx, v); // MiniJson only produces String/Long/Double/Boolean/null, all natively supported by JDBC
  }

  private static void writeJsonValue(StringBuilder out, Object v) throws SQLException {
    if (v == null) { out.append("null"); return; }
    if (v instanceof byte[]) {
      out.append('"').append(escape(Base64.getEncoder().encodeToString((byte[]) v))).append('"'); return;
    }
    if (v instanceof Timestamp || v instanceof java.sql.Date || v instanceof java.sql.Time
        || v instanceof java.util.Date) {
      out.append('"').append(escape(v.toString())).append('"'); return;
    }
    if (v instanceof BigDecimal) {
      out.append('"').append(escape(((BigDecimal) v).toPlainString())).append('"'); return;
    }
    if (v instanceof Long || v instanceof Integer || v instanceof Short || v instanceof Byte) {
      long l = ((Number) v).longValue();
      if (l > 9007199254740991L || l < -9007199254740991L) { // beyond JS 2^53 → string
        out.append('"').append(l).append('"');
      } else {
        out.append(l);
      }
      return;
    }
    if (v instanceof Double || v instanceof Float) {
      double d = ((Number) v).doubleValue();
      if (Double.isNaN(d) || Double.isInfinite(d)) out.append('"').append(d).append('"');
      else out.append(d);
      return;
    }
    if (v instanceof Boolean) { out.append(v); return; }
    out.append('"').append(escape(String.valueOf(v))).append('"');
  }

  private static String escape(String s) {
    if (s == null) return "";
    StringBuilder b = new StringBuilder(s.length() + 8);
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default:
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
          else b.append(c);
      }
    }
    return b.toString();
  }

  // ---------- HTTP / request-field helpers ----------

  private static byte[] readBody(InputStream in) throws IOException {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    byte[] chunk = new byte[8192];
    int n;
    while ((n = in.read(chunk)) > 0) {
      if (buf.size() + n > MAX_BODY) throw new IllegalArgumentException("body too large (max 1MB)");
      buf.write(chunk, 0, n);
    }
    return buf.toByteArray();
  }

  private static void respond(HttpExchange ex, int code, String jsonBody) throws IOException {
    byte[] bytes = jsonBody.getBytes("UTF-8");
    ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    ex.sendResponseHeaders(code, bytes.length);
    try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
  }

  private static String err(String msg) { return "{\"error\":\"" + escape(msg) + "\"}"; }

  private static String requireStr(Map<String, Object> req, String key) {
    Object v = req.get(key);
    if (!(v instanceof String) || ((String) v).isEmpty())
      throw new IllegalArgumentException("missing field: " + key);
    return (String) v;
  }

  private static int requireInt(Map<String, Object> req, String key) {
    Object v = req.get(key);
    if (!(v instanceof Number)) throw new IllegalArgumentException("missing field: " + key);
    return ((Number) v).intValue();
  }

  private static String str(Object v) { return v instanceof String ? (String) v : null; }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> castMap(Object v, String what) {
    if (!(v instanceof Map)) throw new IllegalArgumentException("bad " + what + ": not a json object");
    return (Map<String, Object>) v;
  }

  private static int envInt(String key, int def) {
    String v = System.getenv(key);
    if (v == null || v.isEmpty()) return def;
    try { return Integer.parseInt(v.trim()); } catch (NumberFormatException e) { return def; }
  }

  // ---------- Minimal JSON parser (protocol subset: object/array/string/number/true/false/null) ----------

  static final class MiniJson {
    private final String s;
    private int i;

    private MiniJson(String s) { this.s = s; }

    static Object parse(String text) {
      MiniJson p = new MiniJson(text);
      p.ws();
      Object v = p.value();
      p.ws();
      if (p.i < p.s.length()) throw p.fail("trailing chars");
      return v;
    }

    private Object value() {
      char c = peek();
      if (c == '{') return obj();
      if (c == '[') return arr();
      if (c == '"') return string();
      if (c == 't' || c == 'f' || c == 'n') return literal();
      if (c == '-' || (c >= '0' && c <= '9')) return number();
      throw fail("unexpected '" + c + "'");
    }

    private Map<String, Object> obj() {
      Map<String, Object> m = new LinkedHashMap<String, Object>();
      expect('{'); ws();
      if (peek() == '}') { i++; return m; }
      while (true) {
        if (peek() != '"') throw fail("expected key");
        String k = string(); ws(); expect(':'); ws();
        m.put(k, value()); ws();
        if (peek() == ',') { i++; ws(); continue; }
        if (peek() == '}') { i++; return m; }
        throw fail("expected ',' or '}'");
      }
    }

    private List<Object> arr() {
      List<Object> l = new java.util.ArrayList<Object>();
      expect('['); ws();
      if (peek() == ']') { i++; return l; }
      while (true) {
        l.add(value()); ws();
        if (peek() == ',') { i++; ws(); continue; }
        if (peek() == ']') { i++; return l; }
        throw fail("expected ',' or ']'");
      }
    }

    private String string() {
      expect('"');
      StringBuilder b = new StringBuilder();
      while (true) {
        char c = next();
        if (c == '"') return b.toString();
        if (c == '\\') {
          char e = next();
          switch (e) {
            case '"': b.append('"'); break;
            case '\\': b.append('\\'); break;
            case '/': b.append('/'); break;
            case 'n': b.append('\n'); break;
            case 'r': b.append('\r'); break;
            case 't': b.append('\t'); break;
            case 'b': b.append('\b'); break;
            case 'f': b.append('\f'); break;
            case 'u':
              if (i + 4 > s.length()) throw fail("bad \\u");
              b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
              i += 4;
              break;
            default: throw fail("bad escape '\\" + e + "'");
          }
        } else {
          b.append(c);
        }
      }
    }

    private Object literal() {
      if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
      if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
      if (s.startsWith("null", i)) { i += 4; return null; }
      throw fail("bad literal");
    }

    private Object number() {
      int start = i;
      if (peek() == '-') i++;
      while (i < s.length()) {
        char c = s.charAt(i);
        if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') i++;
        else break;
      }
      String t = s.substring(start, i);
      if (t.indexOf('.') < 0 && t.indexOf('e') < 0 && t.indexOf('E') < 0) {
        try { return Long.parseLong(t); } catch (NumberFormatException ignore) { /* fallthrough */ }
      }
      try { return Double.parseDouble(t); } catch (NumberFormatException e) { throw fail("bad number: " + t); }
    }

    private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
    private char peek() { if (i >= s.length()) throw fail("unexpected end"); return s.charAt(i); }
    private char next() { if (i >= s.length()) throw fail("unexpected end"); return s.charAt(i++); }
    private void expect(char c) { if (next() != c) throw fail("expected '" + c + "'"); }
    private IllegalArgumentException fail(String msg) {
      return new IllegalArgumentException("bad json at " + i + ": " + msg);
    }
  }
}
