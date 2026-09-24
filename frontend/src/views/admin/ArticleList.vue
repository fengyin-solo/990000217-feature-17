<template>
  <div class="article-list-admin">
    <div class="page-header">
      <h2 class="page-title">文章管理</h2>
      <el-button type="primary" @click="goToCreate">
        新建文章
      </el-button>
    </div>
    
    <el-card>
      <el-alert
        v-for="pending in uncertainDeletes"
        :key="pending.scope"
        class="uncertain-alert"
        type="warning"
        :closable="false"
        show-icon
      >
        <template #title>
          文章 #{{ pending.scope.split(':')[1] }} 的删除结果未知，可能已删除
        </template>
        <template #default>
          <el-button size="small" type="warning" plain @click="checkDelete(pending)">
            检查删除结果
          </el-button>
        </template>
      </el-alert>

      <el-table :data="articles" v-loading="loading" style="width: 100%">
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
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../../api'
import { submitWrite, resolvePending, listPending, AmbiguousWriteError } from '../../utils/writeRecovery'
import Pagination from '../../components/Pagination.vue'

const router = useRouter()

const articles = ref([])
const loading = ref(false)
const currentPage = ref(1)
const pagination = ref({
  total: 0,
  page: 1,
  limit: 10,
  totalPages: 0
})
// Deletes whose result was never confirmed (timeout / expired token).
const uncertainDeletes = ref([])

onMounted(async () => {
  await reconcilePendingDeletes()
  fetchArticles()
})

// Re-entering the list after a failed delete: confirm what actually happened
// so the list reflects the true server state without a duplicate delete.
async function reconcilePendingDeletes() {
  const pendingDeletes = listPending().filter(p => p.scope.startsWith('delete:'))

  for (const pending of pendingDeletes) {
    const result = await resolvePending(pending.scope)
    if (result.status === 'completed') {
      ElMessage.success('上次删除已成功')
    } else if (result.status === 'uncertain') {
      uncertainDeletes.value.push(pending)
    }
  }
}

async function checkDelete(pending) {
  const result = await resolvePending(pending.scope)
  if (result.status === 'completed') {
    uncertainDeletes.value = uncertainDeletes.value.filter(p => p.scope !== pending.scope)
    ElMessage.success('删除已成功')
    fetchArticles()
  } else if (result.status === 'not_found') {
    uncertainDeletes.value = uncertainDeletes.value.filter(p => p.scope !== pending.scope)
    ElMessage.info('该删除未生效，可重新操作')
  } else {
    ElMessage.warning('仍无法确认，请重新登录或检查网络后重试')
  }
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

    await submitWrite({
      scope: `delete:${article.id}`,
      method: 'delete',
      url: `/articles/${article.id}`
    })
    ElMessage.success('文章已删除')
    fetchArticles()
  } catch (error) {
    if (error === 'cancel') return

    if (error instanceof AmbiguousWriteError) {
      ElMessage.warning('删除结果未知，可能已经成功。请通过页面上方提示确认，切勿重复删除')
      if (!uncertainDeletes.value.some(p => p.scope === `delete:${article.id}`)) {
        uncertainDeletes.value.push(error.record)
      }
      return
    }

    console.error('Failed to delete article:', error)
    ElMessage.error(error.response?.data?.error || '删除文章失败')
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

.uncertain-alert {
  margin-bottom: 12px;
}
</style>
