#include "SignalingClient.h"

#include <QDebug>
#include <QTimer>

#include "../utils/JsonProtocol.h"

SignalingClient::SignalingClient(QObject* parent) : QObject(parent) {
  connect(&m_webSocket, &QWebSocket::connected, this,
          &SignalingClient::onConnected);
  connect(&m_webSocket, &QWebSocket::textMessageReceived, this,
          &SignalingClient::onTextMessageReceived);

  connect(&m_webSocket, &QWebSocket::errorOccurred, this,
          [](QAbstractSocket::SocketError error) {
            qDebug() << "❌ WebSocket Error:" << error;
          });
}

void SignalingClient::connectToServer(const QString& url) {
  qDebug() << "🔗 Connecting to Signaling Server:" << url;
  m_webSocket.open(QUrl(url));
}

void SignalingClient::onConnected() {
  qDebug() << "✅ Connected to VPS!";

  // 模拟
  registerHost("192.168.1.5", 4433);
}

void SignalingClient::registerHost(const QString& localIp, int quicPort) {
  // 生成 JSON
  QByteArray json =
      Protocol::createRegisterMsg(localIp, quicPort, "DUMMY_CERT_HASH");

  m_webSocket.sendTextMessage(QString::fromUtf8(json));
  qDebug() << "📤 Sent Register Info:" << json;
}

void SignalingClient::onTextMessageReceived(const QString& message) {
  qDebug() << "📩 Recv:" << message;
}
