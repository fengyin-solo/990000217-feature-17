<template>
  <div class="article-list-admin">
    <div class="page-header">
      <h2 class="page-title">文章管理</h2>
      <el-button type="primary" @click="goToCreate">
        新建文章
      </el-button>
    </div>
    
    <el-card>
      <el-table :data="articles" v-loading="loading || reconciling" style="width: 100%">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="title" label="标题" min-width="200" />
        <el-table-column prop="tags" label="标签" width="250">
          <template #default="{ row }">
            <el-tag v-for="tag in row.tags" :key="tag" size="small" class="tag-cell">
              {{ tag }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="150">
          <template #default="{ row }">
            {{ formatDate(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="editArticle(row.id)">
              编辑
            </el-button>
            <el-button type="danger" link @click="deleteArticle(row)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      
      <Pagination
        v-model="currentPage"
        :total="pagination.total"
        :page-size="pagination.limit"
        @change="handlePageChange"
      />
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted, h } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, ElNotification, ElButton } from 'element-plus'
import api from '../../api'
import Pagination from '../../components/Pagination.vue'
import {
  generateIdempotencyKey,
  savePendingOp,
  removePendingOp,
  getPendingOps,
  isAuthError,
  isUncertainError,
  replayPendingOp
} from '../../utils/saveState'

const router = useRouter()

const articles = ref([])
const loading = ref(false)
const reconciling = ref(false)
const currentPage = ref(1)
const pagination = ref({
  total: 0,
  page: 1,
  limit: 10,
  totalPages: 0
})

onMounted(async () => {
  // Confirm deletes/updates whose result was never seen (timeout, expired
  // token, closed tab) before rendering, so the list cannot show an article
  // that the server already deleted or hide one the server kept.
  await reconcilePendingWrites()
  fetchArticles()
})

async function reconcilePendingWrites() {
  const pending = getPendingOps({ scope: 'list' })
  if (pending.length === 0) return

  reconciling.value = true
  for (const op of pending) {
    let keep = false
    try {
      await replayPendingOp(op)
      ElMessage.success(`上次未确认的操作已确认成功（文章 ID：${op.articleId}）`)
    } catch (error) {
      if (isAuthError(error)) {
        // Keep every remaining op; after re-login the page reconciles again
        keep = true
        ElMessage.warning('登录已失效，请重新登录后确认未完成的删除操作')
        router.push({ name: 'Login', query: { redirect: '/admin/articles' } })
        break
      }
      if (isUncertainError(error)) {
        // Still unknown: keep it for the next visit to reconcile
        keep = true
        ElMessage.warning('部分删除操作结果未知，可稍后重试确认')
      }
      // A definitive 4xx means the write did not take effect; drop it.
    }
    if (!keep) removePendingOp(op.idempotencyKey)
  }
  reconciling.value = false
}

async function fetchArticles() {
  loading.value = true
  try {
    const response = await api.get('/articles', {
      params: { page: currentPage.value, limit: pagination.value.limit }
    })
    articles.value = response.data.articles
    pagination.value = response.data.pagination
  } catch (error) {
    console.error('Failed to fetch articles:', error)
    ElMessage.error('获取文章列表失败')
  } finally {
    loading.value = false
  }
}

function handlePageChange(page) {
  currentPage.value = page
  fetchArticles()
}

function goToCreate() {
  router.push('/admin/articles/new')
}

function editArticle(id) {
  router.push(`/admin/articles/${id}/edit`)
}

async function deleteArticle(article) {
  let confirmed
  try {
    await ElMessageBox.confirm(
      `确定要删除文章「${article.title}」吗？`,
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    confirmed = true
  } catch {
    return
  }
  if (!confirmed) return

  // A stable key turns timeout/expired-token/double-click retries into
  // replays: the article is deleted at most once and the outcome is always
  // discoverable by resending the same request.
  const idempotencyKey = generateIdempotencyKey()
  const pendingOp = {
    idempotencyKey,
    method: 'DELETE',
    path: `/articles/${article.id}`,
    data: null,
    scope: 'list',
    articleId: String(article.id)
  }
  savePendingOp(pendingOp)

  try {
    const response = await api.delete(`/articles/${article.id}`, {
      headers: { 'Idempotency-Key': idempotencyKey }
    })
    removePendingOp(idempotencyKey)
    ElMessage.success('文章已删除')
    fetchArticles()
    showRecoverableDelete(article, response.data?.meta?.recoverable)
  } catch (error) {
    console.error('Failed to delete article:', error)

    if (isAuthError(error)) {
      ElMessage.warning('登录已失效，请重新登录，系统会确认该删除是否已生效')
      router.push({
        name: 'Login',
        query: { redirect: '/admin/articles' }
      })
      return
    }

    if (isUncertainError(error)) {
      ElMessage.warning('删除结果未知，重新进入本页时会自动确认，请勿重复删除')
      return
    }

    removePendingOp(idempotencyKey)
    const message = error.response?.data?.error || '删除文章失败'
    ElMessage.error(message)
  }
}

function showRecoverableDelete(article, recoverable) {
  if (!recoverable?.canUndo) return

  ElNotification({
    title: '文章已删除',
    message: () =>
      h('div', { class: 'delete-undo-notice' }, [
        h('span', `「${article.title}」已删除，可在恢复期限内撤销。`),
        h(
          ElButton,
          {
            type: 'primary',
            link: true,
            onClick: async () => {
              await restoreArticle(article, recoverable)
            }
          },
          () => '撤销删除'
        )
      ]),
    type: 'success',
    duration: 10000
  })
}

async function restoreArticle(article, recoverable) {
  const idempotencyKey = generateIdempotencyKey()
  try {
    await api.post(
      recoverable.path || `/articles/${article.id}/restore`,
      { revisionId: recoverable.revisionId },
      { headers: { 'Idempotency-Key': idempotencyKey } }
    )
    ElMessage.success('已撤销删除，文章已恢复')
    fetchArticles()
  } catch (error) {
    console.error('Failed to restore article:', error)
    if (error.response?.data?.code === 'RECOVERY_EXPIRED') {
      ElMessage.error('恢复期限已过，无法撤销删除')
    } else {
      ElMessage.error(error.response?.data?.error || '恢复文章失败')
    }
  }
}

function formatDate(dateStr) {
  const date = new Date(dateStr)
  return date.toLocaleDateString('zh-CN')
}
</script>

<style scoped>
.article-list-admin {
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

.tag-cell {
  margin-right: 4px;
}
</style>
