#include <WiFi.h>
#include <WebServer.h>

// AP 설정
const char* AP_SSID = "ESP32-Light";
const char* AP_PASS = "12345678";

// 핀 설정
const int LDR_PIN = 34;

WebServer server(80);

// 조도값을 퍼센트로 변환 (0~4095 → 0~100%)
// LDR은 밝을수록 값이 낮아지므로 반전
int getLightPercent(int raw) {
  return map(raw, 0, 4095, 0, 100);
}

// 조도 단계 텍스트
String getLightLevel(int percent) {
  if (percent >= 80) return "매우 밝음 ☀️";
  if (percent >= 60) return "밝음 🌤️";
  if (percent >= 40) return "보통 🌥️";
  if (percent >= 20) return "어두움 🌙";
  return "매우 어두움 🌑";
}

void handleRoot() {
  int raw = analogRead(LDR_PIN);
  int percent = getLightPercent(raw);
  String level = getLightLevel(percent);

  String html = R"(
    <html><head>
    <meta charset='UTF-8'>
    <meta name='viewport' content='width=device-width, initial-scale=1'>
    <title>조도 모니터링</title>
    <style>
      body { font-family: sans-serif; text-align: center; padding: 30px; background: #f0f4f8; }
      .card { background: white; border-radius: 16px; padding: 30px; margin: 10px auto; max-width: 320px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
      .value { font-size: 64px; font-weight: bold; color: #333; }
      .label { font-size: 18px; color: #888; margin-top: 8px; }
      .level { font-size: 22px; margin-top: 16px; }
      .bar-bg { background: #eee; border-radius: 8px; height: 20px; margin-top: 16px; }
      .bar { background: #f6c90e; border-radius: 8px; height: 20px; transition: width 0.3s; }
      .raw { font-size: 13px; color: #bbb; margin-top: 12px; }
      .refresh { margin-top: 20px; font-size: 13px; color: #aaa; }
    </style>
    <script>
      // 1초마다 자동 갱신
      setTimeout(() => location.reload(), 1000);
    </script>
    </head><body>
    <h2>💡 조도 모니터링</h2>
    <div class='card'>
      <div class='value'>)" + String(percent) + R"(%</div>
      <div class='label'>밝기</div>
      <div class='bar-bg'><div class='bar' style='width:)" + String(percent) + R"(%'></div></div>
      <div class='level'>)" + level + R"(</div>
      <div class='raw'>RAW: )" + String(raw) + R"( / 4095</div>
    </div>
    <div class='refresh'>1초마다 자동 갱신</div>
    </body></html>
  )";

  server.send(200, "text/html", html);
}

// JSON API
void handleData() {
  int raw = analogRead(LDR_PIN);
  int percent = getLightPercent(raw);

  String json = "{";
  json += "\"raw\":" + String(raw) + ",";
  json += "\"percent\":" + String(percent) + ",";
  json += "\"level\":\"" + getLightLevel(percent) + "\"";
  json += "}";

  server.send(200, "application/json", json);
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12); // 0~4095

  WiFi.softAP(AP_SSID, AP_PASS);
  IPAddress IP = WiFi.softAPIP();

  Serial.println("=== AP 시작 ===");
  Serial.print("SSID: "); Serial.println(AP_SSID);
  Serial.print("접속 주소: http://"); Serial.println(IP);

  server.on("/", handleRoot);
  server.on("/data", handleData);
  server.begin();
}

void loop() {
  server.handleClient();

  // 시리얼로도 확인 가능
  static unsigned long lastPrint = 0;
  if (millis() - lastPrint > 1000) {
    int raw = analogRead(LDR_PIN);
    Serial.printf("RAW: %d | 밝기: %d%%\n", raw, getLightPercent(raw));
    lastPrint = millis();
  }
}
