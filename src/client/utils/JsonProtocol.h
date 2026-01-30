#ifndef JSONPROTOCOL_H
#define JSONPROTOCOL_H

#include <QJsonDocument>
#include <QJsonObject>
#include <QString>

namespace Protocol {
static QByteArray createMessage(const QString& type,
                                const QJsonObject& payload) {
  QJsonObject root;
  root["type"] = type;
  root["payload"] = payload;
  return QJsonDocument(root).toJson(QJsonDocument::Compact);
}

static QByteArray createRegisterMsg(const QString& ip, int port,
                                    const QString& hash) {
  QJsonObject payload;
  payload["ip"] = ip;
  payload["port"] = port;
  payload["certHash"] = hash;
  return createMessage("register_host", payload);
}
}  // namespace Protocol

#endif
