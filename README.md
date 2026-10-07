# firestore-files

Файлы в Cloud Firestore — без Firebase Storage и тарифа Blaze.

Файл режется на куски по ~700 КиБ: документ Firestore ограничен 1 МиБ. Куски лежат в подколлекции, метаданные — в отдельном документе. Всё задаётся одним конфигом, общим для клиента и для правил безопасности: имя коллекции, лимиты и кто может читать, писать и удалять. Правила генерируются из конфига, поэтому клиент и `firestore.rules` не разъезжаются.

```
<collection>/{fileId}                    name, size, type, chunks, complete, createdAt, [uid], [sha256], …свои поля
<collection>/{fileId}/<chunks>/{n}       { i: n, data: Bytes }
```

Файл появляется в `list()` и `subscribe()` только после записи всех кусков (`complete: true`). Оборванная загрузка за собой убирает. Если вкладку закрыли посреди загрузки, остатки чистит `cleanupIncomplete()`.

## Когда это подходит

- Вложения, скриншоты, датапаки и другие файлы до десятков мегабайт в небольшом проекте на бесплатном тарифе.
- Нужны офлайн-кеш Firestore, его правила безопасности и App Check — без отдельного сервиса.

Когда **не** подходит — это цена подхода:

- **Квоты.** Каждый кусок — это одна запись при загрузке и одно чтение при скачивании. Бесплатно в сутки доступно 20 000 записей, 50 000 чтений и 1 ГиБ хранения. Файл 25 МБ — это 37 записей и 37 чтений на каждое скачивание. В кеше Firestore файл не сохраняется, поэтому при повторном открытии читается заново.
- **Видео, раздача публике, большие объёмы** — для этого есть Storage или CDN.
- **Скорость.** Правило куска делает `get()` родителя. Это ещё одно чтение на каждый кусок при записи, а при `$file` в правиле чтения — и при скачивании.

## Установка

```bash
npm i firestore-files firebase
```

## Конфиг

`firestore-files.config.mjs` в корне проекта — его читает CLI, а клиент импортирует тот же объект:

```js
import { defineConfig } from 'firestore-files/rules';

export default defineConfig({
  collection: 'files',
  maxFileSize: 25 * 1024 * 1024,
  // chunksCollection: 'chunks',
  // chunkSize: 700 * 1024,       // до 1 000 000
  // owner: true,                 // хранить uid загрузившего
  // checksum: true,              // SHA-256 при загрузке, проверка при чтении
  rules: {
    read: 'request.auth != null',
    write: 'request.auth != null',
    delete: '$owner',             // по умолчанию $owner при owner: true, иначе — любой вошедший
    validate: '$new.author is string && $new.author.size() <= 40',
  },
});
```

Можно экспортировать массив конфигов — для нескольких коллекций с разными лимитами.

### Правила доступа

Правила — это выражения языка правил Firestore. Можно вызывать свои функции из `firestore.rules`, например `signedIn()` или `isAdmin()`. Доступны подстановки:

| Подстановка | Что значит | Где доступна |
|---|---|---|
| `$file` | метаданные существующего файла (в правилах кусков — `get()` родителя) | `read`, `delete` |
| `$owner` | текущий пользователь загрузил файл (нужен `owner: true`) | `read`, `delete` |
| `$new` | метаданные создаваемого файла | `validate` |

`write` проверяется при создании файла, при записи кусков и при отметке готовности. Подстановок в нём нет: файла ещё нет. Привязку к автору при `owner: true` пакет добавляет сам.

Пакет сам проверяет и служебное: размер файла и куска не выше лимитов, число кусков соответствует размеру, кусок пишется по своему номеру и только в незавершённый файл. Готовый файл нельзя ни дописать, ни изменить.

## Правила: генерация

В `firestore.rules`, внутри `match /databases/{database}/documents`, поставьте маркеры:

```
    // firestore-files:begin files
    // firestore-files:end files
```

Затем:

```bash
npx firestore-files rules --write firestore.rules          # вставить / обновить
npx firestore-files rules --write firestore.rules --check  # в CI: упасть, если правила устарели
npx firestore-files rules                                  # просто напечатать
```

Есть и программный вызов — `generateRules(config)` и `injectRules(source, config)` из `firestore-files/rules`.

## Клиент

```ts
import { createFileStore } from 'firestore-files';
import config from './firestore-files.config.mjs';

const files = createFileStore<{ author: string; taskId: string | null }>(db, config, {
  ready: () => authReady,               // дождаться входа перед запросами
  uid: () => auth.currentUser?.uid,     // нужно при owner: true
});

const f = await files.upload(file, { meta: { author: 'Steve', taskId }, onProgress: (p) => setProgress(p) });
const list = await files.list(where('taskId', '==', taskId), orderBy('createdAt'));
const stop = files.subscribe([where('taskId', '==', taskId)], setFiles);
img.src = await files.objectUrl(f);    // кешируется; освободить — files.release(f.id)
await files.download(f);
await files.remove(f);
```

С `owner: true` и чтением `$owner` запрос списка без фильтра по владельцу Firestore отклонит целиком: он мог бы задеть чужие документы. Используйте `files.list(files.mine())`.

Ошибки — `FileStoreError` с полем `code`: `too-large`, `not-found`, `incomplete`, `corrupted`, `aborted`, `reserved-field`, `no-user`. Загрузку можно отменить через `signal` (AbortController).

## React

`firestore-files/react` — необязательная точка входа; `react` ≥ 18 указан как опциональная зависимость. Хранилище (`fileStore` в примере — результат `createFileStore`) создавайте один раз: вне компонента или в `useMemo`.

```tsx
import { useFiles, useFileUrl, useUpload } from 'firestore-files/react';

function Attachments({ taskId }: { taskId: string }) {
  // Подписка пересоздаётся при смене deps; null вместо условий — выключить
  const { files, loading, error } = useFiles(fileStore, [where('taskId', '==', taskId)], [taskId]);
  const { upload, tasks, cancel, dismiss } = useUpload(fileStore);

  return (
    <>
      <input type="file" multiple onChange={(e) => [...e.target.files!].forEach((f) => upload(f, { meta: { taskId } }))} />
      {tasks.map((t) => (
        <Progress key={t.key} value={t.progress} error={t.error} onCancel={() => cancel(t.key)} />
      ))}
      {files.map((f) => <Thumb key={f.id} file={f} />)}
    </>
  );
}

function Thumb({ file }) {
  const { url } = useFileUrl(fileStore, file); // содержимое кешируется — повторно не качается
  return url ? <img src={url} /> : null;
}
```

- **`useFiles(store, constraints | null, deps)`** возвращает `{ files, loading, error }` и обновляется в реальном времени.
- **`useFileUrl(store, file | id | null)`** возвращает `{ url, loading, error }`. URL общий для всех мест, где показан файл, поэтому при размонтировании он не отзывается. Когда файл больше не нужен, вызовите `store.release(id)`.
- **`useUpload(store, { keepDone })`** возвращает `{ tasks, uploading, upload, cancel, dismiss }`. Поддерживает параллельные загрузки, прогресс и отмену. Задачи с ошибкой или отменой остаются в `tasks`, пока их не уберёт `dismiss()`. При размонтировании незавершённые загрузки отменяются и подчищаются.

## Тесты

```bash
npm test                 # модульные
npm run test:emulator    # сквозные на эмуляторе Firestore (нужны firebase CLI и Java)
```

Сквозные тесты проверяют связку клиента и сгенерированных правил:

- загрузка и побайтное чтение, пустой файл;
- доступ без входа;
- `validate`;
- лимиты размера и кусков в обход клиента;
- запрет дописывать готовый файл;
- `owner` и `mine()`;
- повреждение содержимого;
- отмена загрузки;
- `cleanupIncomplete` и осиротевшие куски.
