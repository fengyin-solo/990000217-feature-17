<template>
  <div class="article-editor">
    <div class="page-header">
      <h2 class="page-title">{{ isEdit ? '编辑文章' : '新建文章' }}</h2>
      <el-space>
        <el-button @click="goBack">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave(false)">
          保存
        </el-button>
      </el-space>
    </div>

    <el-alert
      v-if="reconciling"
      type="info"
      :closable="false"
      show-icon
      title="正在确认上次未完成的保存结果…"
      class="save-alert"
    />
    <el-alert
      v-if="uncertainSave"
      type="warning"
      :closable="false"
      show-icon
      class="save-alert"
      title="保存结果未知（请求超时、网络中断或登录失效后发生）"
      description="服务器可能已经保存成功。请点击“重试确认”核对结果，不要重复新建或多次提交，以免产生重复文章。"
    >
      <template #default>
        <div class="alert-body">
          <span>服务器可能已经保存成功。请点击“重试确认”核对结果，不要重复新建或多次提交，以免产生重复文章。</span>
          <el-button size="small" type="warning" :loading="saving" @click="handleSave(false)">
            重试确认
          </el-button>
        </div>
      </template>
    </el-alert>

    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="80px"
      v-loading="loading"
    >
      <el-form-item label="标题" prop="title">
        <el-input v-model="form.title" placeholder="请输入文章标题" size="large" />
      </el-form-item>

      <el-form-item label="摘要" prop="summary">
        <el-input
          v-model="form.summary"
          type="textarea"
          :rows="3"
          placeholder="请输入文章摘要"
        />
      </el-form-item>

      <el-form-item label="标签" prop="tags">
        <el-input
          v-model="form.tagsInput"
          placeholder="请输入标签，用逗号分隔"
        />
      </el-form-item>

      <el-form-item label="正文" prop="body">
        <el-tabs v-model="activeTab">
          <el-tab-pane label="编辑" name="edit">
            <el-input
              v-model="form.body"
              type="textarea"
              :rows="20"
              placeholder="请输入 Markdown 格式的文章正文"
              class="markdown-editor"
            />
          </el-tab-pane>
          <el-tab-pane label="预览" name="preview">
            <div class="preview-content" v-html="renderedContent"></div>
          </el-tab-pane>
        </el-tabs>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { marked } from 'marked'
import api from '../../api'
import {
  generateIdempotencyKey,
  savePendingOp,
  removePendingOp,
  getPendingOps,
  saveDraft,
  loadDraft,
  clearDraft,
  isAuthError,
  isUncertainError,
  replayPendingOp
} from '../../utils/saveState'

const route = useRoute()
const router = useRouter()

const formRef = ref(null)
const loading = ref(false)
const saving = ref(false)
const reconciling = ref(false)
const uncertainSave = ref(false)
const activeTab = ref('edit')

// Version the editor loaded from the server; sent back on save so the API
// can detect that another writer committed a change in the meantime.
const baseVersion = ref(null)
// Idempotency key of the in-flight / unresolved save; reused on retry.
const activeKey = ref(null)
let ready = false

const isEdit = computed(() => !!route.params.id)
const articleId = computed(() => (isEdit.value ? String(route.params.id) : null))

const form = reactive({
  title: '',
  body: '',
  summary: '',
  tagsInput: ''
})

const rules = {
  title: [
    { required: true, message: '请输入文章标题', trigger: 'blur' }
  ],
  body: [
    { required: true, message: '请输入文章正文', trigger: 'blur' }
  ]
}

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true
})

const renderedContent = computed(() => {
  if (!form.body) return '<p>暂无内容</p>'
  return marked(form.body)
})

// Autosave a local draft so re-entering the page returns to the right state
watch(form, () => {
  if (ready) saveDraft(articleId.value, { ...form })
}, { deep: true })

onMounted(async () => {
  if (isEdit.value) {
    await initEditPage()
  } else {
    await initCreatePage()
  }
  ready = true
})

function applyArticle(article) {
  form.title = article.title || ''
  form.body = article.body || ''
  form.summary = article.summary || ''
  form.tagsInput = Array.isArray(article.tags) ? article.tags.join(', ') : ''
  baseVersion.value = article.version ?? null
}

async function offerDraftRestore() {
  const draft = loadDraft(articleId.value)
  if (!draft) return

  const sameContent =
    draft.title === form.title &&
    draft.body === form.body &&
    draft.summary === form.summary &&
    draft.tagsInput === form.tagsInput
  if (sameContent) {
    clearDraft(articleId.value)
    return
  }

  try {
    await ElMessageBox.confirm(
      '检测到上次未提交的本地草稿，是否恢复到编辑区？（选择“否”将丢弃草稿）',
      '恢复草稿',
      {
        confirmButtonText: '恢复草稿',
        cancelButtonText: '丢弃',
        type: 'info',
        distinguishCancelAndClose: true
      }
    )
    form.title = draft.title || ''
    form.body = draft.body || ''
    form.summary = draft.summary || ''
    form.tagsInput = draft.tagsInput || ''
    ElMessage.success('已恢复本地草稿')
  } catch (action) {
    if (action === 'cancel') clearDraft(articleId.value)
    // closing the dialog keeps the draft and the server content untouched
  }
}

async function fetchArticle() {
  loading.value = true
  try {
    const response = await api.get(`/articles/${route.params.id}`)
    applyArticle(response.data)
    await offerDraftRestore()
  } catch (error) {
    console.error('Failed to fetch article:', error)
    ElMessage.error('获取文章失败')
    router.push('/admin/articles')
  } finally {
    loading.value = false
  }
}

async function initEditPage() {
  // A previous visit may have left a write whose result was never seen
  // (token expired mid-save, timeout, tab closed). Replay it with the same
  // idempotency key before editing so the page opens on the true state.
  const pending = getPendingOps({ scope: 'editor', articleId: articleId.value })
  if (pending.length > 0) {
    reconciling.value = true
    loading.value = true
    const latest = pending[pending.length - 1]
    const older = pending.slice(0, -1)
    let resolved = false
    try {
      const response = await replayPendingOp(latest)
      resolved = true
      older.forEach(op => removePendingOp(op.idempotencyKey))
      removePendingOp(latest.idempotencyKey)
      if (latest.method === 'PUT') {
        applyArticle(response.data)
        const labels = response.data?.meta?.changed?.map(c => c.label)
        ElMessage.success(
          labels && labels.length > 0
            ? `上次未确认的保存已成功（变更：${labels.join('、')}）`
            : '上次未确认的保存已确认：内容无变化'
        )
      }
      // Content was just reconciled from the server; the draft is stale.
      clearDraft(articleId.value)
    } catch (error) {
      older.forEach(op => removePendingOp(op.idempotencyKey))
      if (isAuthError(error)) {
        // Keep the pending op: after re-login this page mounts and replays it
        ElMessage.warning('登录已失效，请重新登录后继续编辑')
        router.push({ name: 'Login', query: { redirect: route.fullPath } })
        return
      }
      if (isUncertainError(error)) {
        // Keep the pending op and its key; user retries from the banner
        activeKey.value = latest.idempotencyKey
        uncertainSave.value = true
      } else if (error.response?.data?.code === 'VERSION_CONFLICT') {
        // A concurrent edit landed first; pending write is moot, load latest
        removePendingOp(latest.idempotencyKey)
        ElMessage.warning('上次保存时内容已被他人更新，请基于最新内容编辑')
      } else {
        // Definitive 4xx (validation/not found): the write never happened
        removePendingOp(latest.idempotencyKey)
      }
    } finally {
      reconciling.value = false
      loading.value = false
    }

    // Fetch from the server unless its state was just applied by the replay.
    if (baseVersion.value === null) {
      await fetchArticle()
    }
    return
  }

  await fetchArticle()
}

async function initCreatePage() {
  // A create whose result was never seen: replay to find out whether the
  // article was created, instead of letting the user submit it again.
  const pending = getPendingOps({ scope: 'editor' }).filter(op => op.method === 'POST' && !op.articleId)
  if (pending.length === 0) return

  reconciling.value = true
  const latest = pending[pending.length - 1]
  const older = pending.slice(0, -1)
  try {
    const response = await replayPendingOp(latest)
    ;[...older, latest].forEach(op => removePendingOp(op.idempotencyKey))
    clearDraft('new')
    ElMessage.success(
      `检测到上次新建文章的结果未确认，已确认创建成功：${response.data.title}，请勿重复创建`
    )
    router.replace('/admin/articles')
  } catch (error) {
    older.forEach(op => removePendingOp(op.idempotencyKey))
    if (isAuthError(error)) {
      // Keep the pending op: it will be reconciled again after re-login
      ElMessage.warning('登录已失效，请重新登录后继续')
      router.push({ name: 'Login', query: { redirect: route.fullPath } })
      return
    }
    if (isUncertainError(error)) {
      // Keep the latest op and its key so the banner replays, not recreates
      activeKey.value = latest.idempotencyKey
      uncertainSave.value = true
    } else {
      removePendingOp(latest.idempotencyKey)
    }
  } finally {
    reconciling.value = false
  }
}

function buildPayload(force) {
  const tags = form.tagsInput
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0)

  const payload = {
    title: form.title,
    body: form.body,
    summary: form.summary,
    tags
  }
  if (isEdit.value && !force && baseVersion.value !== null) {
    payload.version = baseVersion.value
  }
  return payload
}

async function handleSave(force) {
  if (!formRef.value) return

  await formRef.value.validate(async (valid) => {
    if (!valid || saving.value) return

    const payload = buildPayload(force)
    const key = activeKey.value || generateIdempotencyKey()
    activeKey.value = key
    const method = isEdit.value ? 'PUT' : 'POST'
    const path = isEdit.value ? `/articles/${route.params.id}` : '/articles'

    savePendingOp({
      idempotencyKey: key,
      method,
      path,
      data: payload,
      scope: 'editor',
      articleId: articleId.value
    })

    saving.value = true
    uncertainSave.value = false
    try {
      const config = { headers: { 'Idempotency-Key': key } }
      const response = isEdit.value
        ? await api.put(path, payload, config)
        : await api.post(path, payload, config)

      removePendingOp(key)
      activeKey.value = null

      const labels = response.data?.meta?.changed?.map(c => c.label).filter(Boolean)
      if (isEdit.value) {
        ElMessage.success(
          labels && labels.length > 0
            ? `文章已更新，最近变更：${labels.join('、')}`
            : '内容无变化，已是最新版本'
        )
        clearDraft(articleId.value)
      } else {
        ElMessage.success('文章已创建')
        clearDraft('new')
      }
      router.push('/admin/articles')
    } catch (error) {
      console.error('Failed to save article:', error)

      if (error.response?.data?.code === 'VERSION_CONFLICT') {
        // The write did not land; drop its pending record but keep the draft
        removePendingOp(key)
        activeKey.value = null
        await handleVersionConflict(error.response.data.current)
        return
      }

      if (isAuthError(error)) {
        // Pending op and draft stay on disk; after re-login the page mount
        // replays this same key and restores the correct state.
        ElMessage.warning('登录已失效，请重新登录，系统会确认本次保存是否已成功')
        router.push({ name: 'Login', query: { redirect: route.fullPath } })
        return
      }

      if (isUncertainError(error)) {
        uncertainSave.value = true
        ElMessage.warning('保存结果未知，请点击“重试确认”，请勿重复提交')
        return
      }

      // Definitive client/validation errors: the write did not happen
      removePendingOp(key)
      activeKey.value = null
      const message = error.response?.data?.error || '保存文章失败'
      ElMessage.error(message)
    } finally {
      saving.value = false
    }
  })
}

async function handleVersionConflict(current) {
  try {
    await ElMessageBox.confirm(
      '文章内容在你编辑期间已被其他操作更新。加载最新内容会覆盖当前编辑区（本地草稿已保留）；强制覆盖会用你的内容提交并丢弃他人的修改。',
      '内容已被更新',
      {
        confirmButtonText: '加载最新内容',
        cancelButtonText: '强制覆盖',
        type: 'warning',
        distinguishCancelAndClose: true
      }
    )
    if (current) {
      applyArticle(current)
      ElMessage.info('已加载最新内容，请在此基础上继续编辑')
    }
  } catch (action) {
    if (action === 'cancel') {
      ElMessage.info('将以你的内容强制覆盖最新版本')
      await handleSave(true)
    }
  }
}

function goBack() {
  router.push('/admin/articles')
}
</script>

<style scoped>
.article-editor {
  padding-top: 20px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.page-title {
  font-size: 24px;
  color: #303133;
  margin: 0;
}

.save-alert {
  margin-bottom: 16px;
}

.alert-body {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.markdown-editor :deep(textarea) {
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  font-size: 14px;
}

.preview-content {
  padding: 16px;
  background-color: #fff;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  min-height: 400px;
  max-height: 600px;
  overflow-y: auto;
}

.preview-content :deep(h1) {
  font-size: 24px;
  margin: 16px 0;
}

.preview-content :deep(h2) {
  font-size: 20px;
  margin: 14px 0;
}

.preview-content :deep(h3) {
  font-size: 18px;
  margin: 12px 0;
}

.preview-content :deep(pre) {
  background-color: #f5f7fa;
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
}

.preview-content :deep(code) {
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  font-size: 14px;
}

.preview-content :deep(p) {
  margin-bottom: 12px;
}
</style>
