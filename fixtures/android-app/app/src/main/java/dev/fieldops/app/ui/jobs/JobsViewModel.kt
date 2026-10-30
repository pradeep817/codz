package dev.fieldops.app.ui.jobs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.fieldops.app.data.api.JobApi
import javax.inject.Inject
import kotlinx.coroutines.launch

@HiltViewModel
class JobsViewModel @Inject constructor(private val api: JobApi) : ViewModel() {
    fun refresh() {
        viewModelScope.launch {
            val jobs = api.getJobs()
            println(jobs.first().createdAt)
        }
    }
}
