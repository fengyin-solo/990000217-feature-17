<template>
  <div class="article-editor">
    <div class="page-header">
      <h2 class="page-title">{{ isEdit ? '编辑文章' : '新建文章' }}</h2>
      <el-space>
        <el-button @click="goBack">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">
          保存
        </el-button>
      </el-space>
    </div>
    
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

    <el-alert
      v-if="uncertain"
      class="uncertain-alert"
      type="warning"
      :closable="false"
      show-icon
      title="保存结果未知"
    >
      <template #default>
        <div class="uncertain-actions">
          <span>网络超时或登录已失效，无法确认上次保存是否成功。请勿重复提交，可在重新登录后检查上次结果。</span>
          <el-button size="small" type="warning" plain @click="checkPending">
            检查上次结果
          </el-button>
          <el-button v-if="isEdit" size="small" @click="fetchArticle">
            刷新当前状态
          </el-button>
        </div>
      </template>
    </el-alert>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { marked } from 'marked'
import api from '../../api'
import {
  submitWrite,
  resolvePending,
  AmbiguousWriteError
} from '../../utils/writeRecovery'

const route = useRoute()
const router = useRouter()

const formRef = ref(null)
const loading = ref(false)
const saving = ref(false)
const activeTab = ref('edit')
// Version loaded from the server; sent with updates for optimistic locking.
const loadedVersion = ref(null)
// A previous save ended ambiguously (timeout / expired token).
const uncertain = ref(false)

const isEdit = computed(() => !!route.params.id)
const pendingScope = computed(() =>
  isEdit.value ? `edit:${route.params.id}` : 'create'
)

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

onMounted(async () => {
  if (isEdit.value) {
    // Reconcile any unresolved save before showing stale local content,
    // so re-entering the editor always lands on the correct state.
    await reconcilePending()
    await fetchArticle()
  } else {
    await reconcilePending()
  }
})

function applyArticle(article) {
  form.title = article.title
  form.body = article.body
  form.summary = article.summary || ''
  form.tagsInput = (article.tags || []).join(', ')
  if (article.version !== undefined && article.version !== null) {
    loadedVersion.value = article.version
  }
}

// Resolve a save whose response was lost before the user could see it.
async function reconcilePending() {
  const result = await resolvePending(pendingScope.value)

  if (result.status === 'completed') {
    const saved = result.response
    uncertain.value = false
    if (saved?.id && !isEdit.value) {
      // A "create" actually succeeded: jump to the created article's editor
      // so repeated saves update it instead of inserting duplicates.
      ElMessage.success('上次创建已成功，已为你打开该文章')
      router.replace(`/admin/articles/${saved.id}/edit`)
      return true
    }
    if (isEdit.value && saved) {
      applyArticle(saved)
      ElMessage.success('上次保存已成功，内容已恢复为最新版本')
    }
    return true
  }

  if (result.status === 'uncertain') {
    uncertain.value = true
    return false
  }

  uncertain.value = false
  return false
}

async function fetchArticle() {
  loading.value = true
  try {
    const response = await api.get(`/articles/${route.params.id}`)
    applyArticle(response.data)
    uncertain.value = false
  } catch (error) {
    console.error('Failed to fetch article:', error)
    ElMessage.error('获取文章失败')
    router.push('/admin/articles')
  } finally {
    loading.value = false
  }
}

// Manual reconciliation from the "check last result" banner.
async function checkPending() {
  const handled = await reconcilePending()
  if (!handled) {
    ElMessage.warning('仍无法确认上次结果，请重新登录或检查网络后重试')
  }
}

function parseTags() {
  return form.tagsInput
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0)
}

async function handleSave() {
  if (!formRef.value || saving.value) return

  await formRef.value.validate(async (valid) => {
    if (!valid) return

    saving.value = true
    const articleData = {
      title: form.title,
      body: form.body,
      summary: form.summary,
      tags: parseTags()
    }

    try {
      let result

      if (isEdit.value) {
        // Send the loaded version; a concurrent edit causes a 409.
        const payload = { ...articleData, version: loadedVersion.value }
        result = await submitWrite({
          scope: pendingScope.value,
          method: 'put',
          url: `/articles/${route.params.id}`,
          payload
        })
      } else {
        result = await submitWrite({
          scope: pendingScope.value,
          method: 'post',
          url: '/articles',
          payload: articleData
        })
      }

      uncertain.value = false
      const saved = result.data
      if (saved?.version !== undefined) {
        loadedVersion.value = saved.version
      }

      if (result.replayed) {
        ElMessage.success('文章已保存（检测到重复提交，已返回首次保存结果）')
      } else {
        ElMessage.success(isEdit.value ? '文章已更新' : '文章已创建')
      }

      if (!isEdit.value && saved?.id) {
        router.replace(`/admin/articles/${saved.id}/edit`)
      } else {
        router.push('/admin/articles')
      }
    } catch (error) {
      if (error instanceof AmbiguousWriteError) {
        uncertain.value = true
        ElMessage.warning('保存结果未知，可能已经成功。请检查上次结果，切勿重复提交')
        return
      }

      if (error.response?.status === 409 && error.response.data?.code === 'VERSION_CONFLICT') {
        await handleVersionConflict(error.response.data.current, articleData)
        return
      }

      console.error('Failed to save article:', error)
      const message = error.response?.data?.error || '保存文章失败'
      ElMessage.error(message)
    } finally {
      saving.value = false
    }
  })
}

// Another editor saved first: offer the server version or keep local edits.
async function handleVersionConflict(current, localData) {
  try {
    await ElMessageBox.confirm(
      '文章在你编辑期间已被其他人更新。加载最新版本会覆盖当前表单内容；继续保留则仍可基于你的修改再次保存。',
      '内容已被更新',
      {
        confirmButtonText: '加载最新版本',
        cancelButtonText: '保留我的修改',
        type: 'warning',
        distinguishCancelAndClose: true
      }
    )
    applyArticle(current)
    ElMessage.info('已加载最新版本，请在此基础上继续编辑')
  } catch (action) {
    if (action === 'cancel') {
      // Keep local edits but advance to the new version so the next save
      // is treated as an explicit overwrite rather than another conflict.
      loadedVersion.value = current?.version ?? null
      ElMessage.info('已保留你的修改，再次保存将覆盖最新版本')
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

.markdown-editor :deep(textarea) {
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  font-size: 14px;
}

.uncertain-alert {
  margin-top: 16px;
}

.uncertain-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
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
