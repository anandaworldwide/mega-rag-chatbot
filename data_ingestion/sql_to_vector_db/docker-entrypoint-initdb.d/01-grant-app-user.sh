#!/bin/bash
# The official image creates MYSQL_USER with no schema privileges unless
# MYSQL_DATABASE is set. The importer must be able to CREATE DATABASE.
set -euo pipefail

if [ -z "${MYSQL_USER:-}" ] || [ "$MYSQL_USER" = "root" ]; then
  exit 0
fi

mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
GRANT ALL PRIVILEGES ON *.* TO '${MYSQL_USER}'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL
